import { v4 as uuidv4 } from 'uuid';
import pg from 'pg';
import { withTransaction, getPool } from '../../database/connection.js';
import { GatewayRegistry } from '../../gateways/registry.js';
import { TransactionRepository } from '../../database/repositories/transaction.repository.js';
import { PaymentAttemptRepository } from '../../database/repositories/attempt.repository.js';
import { NotFoundError } from '../../shared/errors/index.js';
import { logger } from '../../shared/logging/logger.js';
import { config } from '../../shared/config/index.js';

export class ReconciliationService {
  static async triggerRun(
    triggerSource: 'SCHEDULED' | 'MANUAL' = 'MANUAL',
    staleMinutes: number = config.RECONCILIATION_STALE_MINUTES
  ): Promise<{ runId: string; status: string; scannedCount: number; mismatchCount: number }> {
    const traceId = uuidv4();
    const runId = uuidv4();
    const pool = getPool();

    // 1. Create run record
    await pool.query(
      `
      INSERT INTO reconciliation_runs (id, trigger_source, status, trace_id, started_at)
      VALUES ($1, $2, 'RUNNING', $3, NOW())
    `,
      [runId, triggerSource, traceId]
    );

    let scannedCount = 0;
    let mismatchCount = 0;

    try {
      // 2. Identify stale transactions
      const staleRes = await pool.query(
        `
        SELECT t.*, pa.id as attempt_id, pa.gateway, pa.provider_payment_ref
        FROM transactions t
        LEFT JOIN payment_attempts pa ON pa.transaction_id = t.id AND pa.status IN ('SENT', 'UNKNOWN', 'AUTHORISED')
        WHERE t.state IN ('AUTH_INITIATED', 'AUTH_TIMEOUT', 'CAPTURE_INITIATED')
          AND t.created_at <= NOW() - ($1 || ' minutes')::INTERVAL
        ORDER BY t.created_at ASC
      `,
        [staleMinutes]
      );

      const staleList = staleRes.rows;
      scannedCount = staleList.length;

      for (const row of staleList) {
        if (!row.gateway || !row.provider_payment_ref) continue;

        try {
          const adapter = GatewayRegistry.get(row.gateway);
          const gwStatus = await adapter.fetchPaymentStatus({
            transactionId: row.id,
            attemptId: row.attempt_id,
            providerPaymentRef: row.provider_payment_ref,
            traceId
          });

          await withTransaction(async (client) => {
            const currentTx = await TransactionRepository.lockForUpdate(client, row.id);

            // Check for critical anomaly: internal CAPTURED vs provider FAILED
            if (currentTx.state === 'CAPTURED' && gwStatus.status === 'FAILED') {
              mismatchCount++;
              const anomalyLogId = uuidv4();
              await client.query(
                `
                INSERT INTO reconciliation_log (
                  id, run_id, transaction_id, attempt_id, gateway, internal_state,
                  provider_state, discrepancy_type, action, outcome, trace_id
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
              `,
                [
                  anomalyLogId,
                  runId,
                  currentTx.id,
                  row.attempt_id,
                  row.gateway,
                  currentTx.state,
                  gwStatus.status,
                  'INTERNAL_CAPTURED_VS_GATEWAY_FAILED',
                  'FLAG_CRITICAL_ANOMALY',
                  'ANOMALY',
                  traceId
                ]
              );

              await client.query(
                `
                INSERT INTO reconciliation_anomalies (
                  run_id, transaction_id, reconciliation_log_id, severity,
                  anomaly_type, description, trace_id
                ) VALUES ($1, $2, $3, 'CRITICAL', $4, $5, $6)
              `,
                [
                  runId,
                  currentTx.id,
                  anomalyLogId,
                  'CAPTURED_PAYMENT_MARKED_FAILED_BY_PROVIDER',
                  `Transaction ${currentTx.id} is confirmed CAPTURED internally but gateway ${row.gateway} reported FAILED. Preserving captured state and alerting.`,
                  traceId
                ]
              );

              logger.fatal({
                transaction_id: currentTx.id,
                gateway: row.gateway,
                message: 'CRITICAL RECONCILIATION ANOMALY: Internal CAPTURED vs Gateway FAILED!'
              });
              return;
            }

            // Normal state reconciliation
            if (
              (currentTx.state === 'AUTH_INITIATED' || currentTx.state === 'AUTH_TIMEOUT') &&
              (gwStatus.status === 'AUTHORISED' || gwStatus.status === 'CAPTURED')
            ) {
              mismatchCount++;
              const toState = gwStatus.status;
              await TransactionRepository.transitionState(client, {
                transactionId: currentTx.id,
                toState,
                event: 'RECONCILIATION_OVERRIDE',
                traceId,
                createdBy: 'reconciliation_engine',
                attemptId: row.attempt_id,
                gatewayReference: row.provider_payment_ref,
                authorized_minor: currentTx.amount_minor,
                captured_minor: toState === 'CAPTURED' ? currentTx.amount_minor : '0'
              });

              await PaymentAttemptRepository.updateStatus(client, {
                attempt_id: row.attempt_id,
                status: toState
              });

              await client.query(
                `
                INSERT INTO reconciliation_log (
                  run_id, transaction_id, attempt_id, gateway, internal_state,
                  provider_state, discrepancy_type, action, outcome, trace_id
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
              `,
                [
                  runId,
                  currentTx.id,
                  row.attempt_id,
                  row.gateway,
                  currentTx.state,
                  toState,
                  'STALE_AUTH_RESOLVED',
                  `TRANSITION_TO_${toState}`,
                  'CORRECTED',
                  traceId
                ]
              );
            } else if (
              currentTx.state === 'CAPTURE_INITIATED' &&
              gwStatus.status === 'CAPTURED'
            ) {
              mismatchCount++;
              await TransactionRepository.transitionState(client, {
                transactionId: currentTx.id,
                toState: 'CAPTURED',
                event: 'RECONCILIATION_OVERRIDE',
                traceId,
                createdBy: 'reconciliation_engine',
                attemptId: row.attempt_id,
                gatewayReference: row.provider_payment_ref,
                captured_minor: currentTx.authorized_minor
              });

              await client.query(
                `
                INSERT INTO reconciliation_log (
                  run_id, transaction_id, attempt_id, gateway, internal_state,
                  provider_state, discrepancy_type, action, outcome, trace_id
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
              `,
                [
                  runId,
                  currentTx.id,
                  row.attempt_id,
                  row.gateway,
                  currentTx.state,
                  'CAPTURED',
                  'STALE_CAPTURE_RESOLVED',
                  'TRANSITION_TO_CAPTURED',
                  'CORRECTED',
                  traceId
                ]
              );
            } else {
              // Match or no discrepancy
              await client.query(
                `
                INSERT INTO reconciliation_log (
                  run_id, transaction_id, attempt_id, gateway, internal_state,
                  provider_state, discrepancy_type, action, outcome, trace_id
                ) VALUES ($1, $2, $3, $4, $5, $6, NULL, 'NO_ACTION', 'MATCH', $7)
              `,
                [
                  runId,
                  currentTx.id,
                  row.attempt_id,
                  row.gateway,
                  currentTx.state,
                  gwStatus.status,
                  traceId
                ]
              );
            }
          });
        } catch (itemErr: any) {
          logger.error({ itemErr, transactionId: row.id }, 'Error reconciling transaction');
        }
      }

      // Mark run completed
      await pool.query(
        `
        UPDATE reconciliation_runs
        SET status = 'COMPLETED',
            scanned_count = $1,
            mismatch_count = $2,
            completed_at = NOW()
        WHERE id = $3
      `,
        [scannedCount, mismatchCount, runId]
      );
    } catch (err: any) {
      await pool.query(
        `
        UPDATE reconciliation_runs
        SET status = 'FAILED',
            completed_at = NOW()
        WHERE id = $1
      `,
        [runId]
      );
      throw err;
    }

    return {
      runId,
      status: 'COMPLETED',
      scannedCount,
      mismatchCount
    };
  }

  static async getReport(runId: string): Promise<any> {
    const pool = getPool();
    const runRes = await pool.query(
      `SELECT * FROM reconciliation_runs WHERE id = $1`,
      [runId]
    );

    if (!runRes.rows[0]) {
      throw new NotFoundError(`Reconciliation run ${runId} not found`, 'RUN_NOT_FOUND');
    }

    const run = runRes.rows[0];
    const logRes = await pool.query(
      `SELECT * FROM reconciliation_log WHERE run_id = $1 ORDER BY created_at ASC`,
      [runId]
    );
    const anomaliesRes = await pool.query(
      `SELECT * FROM reconciliation_anomalies WHERE run_id = $1 ORDER BY created_at ASC`,
      [runId]
    );

    return {
      run_id: run.id,
      trigger_source: run.trigger_source,
      status: run.status,
      scanned_count: run.scanned_count,
      mismatch_count: run.mismatch_count,
      started_at: run.started_at,
      completed_at: run.completed_at,
      logs: logRes.rows,
      anomalies: anomaliesRes.rows
    };
  }
}

