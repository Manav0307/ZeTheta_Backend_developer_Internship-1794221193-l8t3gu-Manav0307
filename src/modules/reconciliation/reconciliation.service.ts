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
        LEFT JOIN payment_attempts pa ON pa.transaction_id = t.id AND pa.status IN ('SENT', 'UNKNOWN', 'AUTHORISED', 'CAPTURED')
        WHERE (t.state IN ('AUTH_INITIATED', 'AUTH_TIMEOUT', 'CAPTURE_INITIATED') OR t.state = 'CAPTURED')
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

  static async reconcileSettlementBatch(params: {
    settlementFileRecords: Array<{ providerReference: string; amountMinor: string; gateway: string }>;
    transactionIds?: string[];
    triggerSource?: 'SCHEDULED' | 'MANUAL';
  }): Promise<{ runId: string; status: string; scannedCount: number; mismatchCount: number; anomalies: any[] }> {
    const traceId = uuidv4();
    const runId = uuidv4();
    const pool = getPool();
    const triggerSource = params.triggerSource || 'MANUAL';

    await pool.query(
      `
      INSERT INTO reconciliation_runs (id, trigger_source, status, trace_id, started_at)
      VALUES ($1, $2, 'RUNNING', $3, NOW())
    `,
      [runId, triggerSource, traceId]
    );

    let scannedCount = 0;
    let mismatchCount = 0;
    const recordedAnomalies: any[] = [];

    try {
      // Query internal captured transactions
      let query = `
        SELECT t.*, pa.id as attempt_id, pa.gateway, pa.provider_payment_ref
        FROM transactions t
        JOIN payment_attempts pa ON pa.transaction_id = t.id AND pa.status IN ('CAPTURED', 'AUTHORISED')
        WHERE t.state IN ('CAPTURED', 'SETTLED')
      `;
      const queryParams: any[] = [];
      if (params.transactionIds && params.transactionIds.length > 0) {
        query += ` AND t.id = ANY($1::UUID[])`;
        queryParams.push(params.transactionIds);
      }
      query += ` ORDER BY t.created_at ASC`;

      const res = await pool.query(query, queryParams);
      const transactions = res.rows;
      scannedCount = transactions.length;

      const settlementMap = new Map<string, { providerReference: string; amountMinor: string; gateway: string }>();
      for (const s of params.settlementFileRecords) {
        settlementMap.set(s.providerReference, s);
      }

      for (const tx of transactions) {
        const matchingSettlement = tx.provider_payment_ref ? settlementMap.get(tx.provider_payment_ref) : undefined;

        if (!matchingSettlement) {
          // FS-11: Missing settlement anomaly!
          mismatchCount++;
          const anomalyLogId = uuidv4();

          await withTransaction(async (client) => {
            // Lock transaction to ensure consistency
            const currentTx = await TransactionRepository.lockForUpdate(client, tx.id);

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
                tx.attempt_id,
                tx.gateway,
                currentTx.state,
                'MISSING_IN_SETTLEMENT_FILE',
                'RECONCILIATION_MISMATCH',
                'FLAG_SETTLEMENT_ANOMALY',
                'ANOMALY',
                traceId
              ]
            );

            const anomalyInsert = await client.query(
              `
              INSERT INTO reconciliation_anomalies (
                run_id, transaction_id, reconciliation_log_id, severity,
                anomaly_type, description, trace_id
              ) VALUES ($1, $2, $3, 'HIGH', $4, $5, $6)
              RETURNING *
            `,
              [
                runId,
                currentTx.id,
                anomalyLogId,
                'MISSING_SETTLEMENT',
                `Payment ${currentTx.id} (ref: ${tx.provider_payment_ref}) is CAPTURED internally but missing from gateway settlement records. Preserving financial state (NO auto-refund).`,
                traceId
              ]
            );
            recordedAnomalies.push(anomalyInsert.rows[0]);

            // Append investigation record to transaction audit ledger
            await client.query(
              `
              INSERT INTO transaction_state_log (
                transaction_id, attempt_id, from_state, to_state, event,
                gateway_reference, gateway_response, metadata, trace_id, created_by
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            `,
              [
                currentTx.id,
                tx.attempt_id,
                currentTx.state,
                currentTx.state,
                'SETTLEMENT_INVESTIGATION_LOGGED',
                tx.provider_payment_ref,
                JSON.stringify({ missing_in_settlement_batch: true }),
                JSON.stringify({
                  anomaly_type: 'MISSING_SETTLEMENT',
                  discrepancy: 'RECONCILIATION_MISMATCH',
                  auto_refund_blocked: true,
                  investigation_required: true
                }),
                traceId,
                'reconciliation_engine'
              ]
            );
          });

          logger.warn({
            transactionId: tx.id,
            gateway: tx.gateway,
            providerReference: tx.provider_payment_ref,
            message: 'SETTLEMENT ANOMALY: Payment captured internally but missing from settlement file!'
          });
        } else {
          // Settlement match: transition to SETTLED if not already SETTLED
          await withTransaction(async (client) => {
            const currentTx = await TransactionRepository.lockForUpdate(client, tx.id);
            if (currentTx.state === 'CAPTURED') {
              await TransactionRepository.transitionState(client, {
                transactionId: currentTx.id,
                toState: 'SETTLED',
                event: 'SETTLEMENT_CONFIRMED',
                traceId,
                createdBy: 'reconciliation_engine',
                attemptId: tx.attempt_id,
                gatewayReference: tx.provider_payment_ref
              });
            }

            await client.query(
              `
              INSERT INTO reconciliation_log (
                run_id, transaction_id, attempt_id, gateway, internal_state,
                provider_state, discrepancy_type, action, outcome, trace_id
              ) VALUES ($1, $2, $3, $4, $5, $6, NULL, 'SETTLEMENT_CONFIRMED', 'MATCH', $7)
            `,
              [
                runId,
                currentTx.id,
                tx.attempt_id,
                tx.gateway,
                currentTx.state,
                'SETTLED',
                traceId
              ]
            );
          });
        }
      }

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
      mismatchCount,
      anomalies: recordedAnomalies
    };
  }
}


