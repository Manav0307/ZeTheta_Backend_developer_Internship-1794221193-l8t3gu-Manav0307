import { v4 as uuidv4 } from 'uuid';
import { getPool, withTransaction } from '../../database/connection.js';
import { TransactionRepository } from '../../database/repositories/transaction.repository.js';
import { PaymentAttemptRepository } from '../../database/repositories/attempt.repository.js';
import { GatewayRegistry } from '../../gateways/registry.js';
import { logger } from '../../shared/logging/logger.js';

export interface RetryQueueItem {
  id: string;
  transaction_id: string;
  attempt_id: string | null;
  action: 'CAPTURE' | 'STATUS_POLL' | 'FAILOVER';
  retry_count: number;
  max_retries: number;
  next_retry_at: Date;
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'DLQ';
  error_message: string | null;
  payload: Record<string, any>;
  created_at: Date;
  updated_at: Date;
}

/**
 * Calculates exponential backoff with jitter (C1 Requirement, PDF-C p.35):
 * 1s, 2s, 4s with randomized jitter rather than burst retries.
 */
export function calculateBackoffWithJitter(
  attempt: number,
  baseMs = 1000,
  capMs = 4000,
  jitterFraction = 0.25
): number {
  const exp = Math.min(capMs, baseMs * Math.pow(2, attempt));
  const jitterRange = exp * jitterFraction;
  const jitter = (Math.random() * 2 - 1) * jitterRange;
  return Math.max(100, Math.round(exp + jitter));
}

export class PaymentRetryService {
  /**
   * Enqueues an asynchronous retry job into persistent storage.
   * Ensures checkout thread is not blocked by slow retries (C1).
   */
  static async enqueueRetry(params: {
    transactionId: string;
    attemptId?: string | null;
    action: 'CAPTURE' | 'STATUS_POLL' | 'FAILOVER';
    maxRetries?: number;
    delayMs?: number;
    payload?: Record<string, any>;
  }): Promise<string> {
    const pool = getPool();
    const delay = params.delayMs !== undefined ? params.delayMs : calculateBackoffWithJitter(0);
    const maxRetries = params.maxRetries || 3;

    const res = await pool.query(
      `
      INSERT INTO payment_retry_queue (
        transaction_id, attempt_id, action, retry_count, max_retries,
        next_retry_at, status, payload
      ) VALUES ($1, $2, $3, 0, $4, NOW() + ($5 || ' milliseconds')::INTERVAL, 'PENDING', $6)
      RETURNING id
      `,
      [
        params.transactionId,
        params.attemptId || null,
        params.action,
        maxRetries,
        delay,
        JSON.stringify(params.payload || {})
      ]
    );

    const jobId = res.rows[0].id;
    logger.info({
      action: 'payment_retry_enqueued',
      job_id: jobId,
      transaction_id: params.transactionId,
      retry_action: params.action,
      next_retry_delay_ms: delay,
      message: 'Persistent async retry job enqueued'
    });

    return jobId;
  }

  /**
   * Processes the next available retry job using FOR UPDATE SKIP LOCKED.
   * Distributed worker safe: multiple workers will never process the same retry job.
   */
  static async processNextRetryJob(): Promise<boolean> {
    let job: RetryQueueItem | null = null;

    await withTransaction(async (client) => {
      const res = await client.query(
        `
        SELECT * FROM payment_retry_queue
        WHERE (status = 'PENDING' OR (status = 'FAILED' AND next_retry_at <= NOW()))
           OR (status = 'PROCESSING' AND lease_expires_at < NOW())
        ORDER BY next_retry_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
        `
      );

      if (res.rowCount && res.rowCount > 0) {
        job = res.rows[0];
        await client.query(
          `
          UPDATE payment_retry_queue
          SET status = 'PROCESSING',
              lease_expires_at = NOW() + INTERVAL '30 seconds',
              updated_at = NOW()
          WHERE id = $1
          `,
          [job!.id]
        );
      }
    });

    if (!job) {
      return false; // Queue empty or no eligible jobs
    }

    const currentJob = job as RetryQueueItem;

    try {
      const pool = getPool();
      const tx = await TransactionRepository.findById(pool, currentJob.transaction_id);

      if (!tx) {
        throw new Error(`Transaction ${currentJob.transaction_id} not found`);
      }

      // If already in terminal success state, mark completed immediately without double-work
      if (tx.state === 'CAPTURED' || tx.state === 'SETTLED') {
        await pool.query(
          `UPDATE payment_retry_queue SET status = 'COMPLETED', updated_at = NOW() WHERE id = $1`,
          [currentJob.id]
        );
        return true;
      }

      if (currentJob.action === 'CAPTURE') {
        // Find active attempt
        const attempts = await PaymentAttemptRepository.listByTransactionId(pool, tx.id);
        const activeAttempt = attempts.find((a: any) => a.id === currentJob.attempt_id) || attempts[0];

        if (activeAttempt) {
          const adapter = GatewayRegistry.get(activeAttempt.gateway);
          const outcome = await adapter.capture({
            transactionId: tx.id,
            attemptId: activeAttempt.id,
            providerPaymentRef: activeAttempt.provider_payment_ref || `pay_ref_${uuidv4()}`,
            amountMinor: tx.amount_minor,
            traceId: tx.trace_id
          });

          if (outcome.status === 'CAPTURED') {
            await withTransaction(async (client) => {
              await PaymentAttemptRepository.updateStatus(client, {
                attempt_id: activeAttempt.id,
                status: 'CAPTURED'
              });

              await TransactionRepository.transitionState(client, {
                transactionId: tx.id,
                toState: 'CAPTURED',
                event: 'CAPTURE_COMPLETE',
                traceId: tx.trace_id,
                createdBy: 'async_retry_worker',
                attemptId: activeAttempt.id,
                authorized_minor: tx.amount_minor,
                captured_minor: tx.amount_minor
              });

              await client.query(
                `UPDATE payment_retry_queue SET status = 'COMPLETED', updated_at = NOW() WHERE id = $1`,
                [currentJob.id]
              );
            });
            return true;
          }
        }
        throw new Error('Capture attempt failed downstream');
      }

      // Action succeeded
      await pool.query(
        `UPDATE payment_retry_queue SET status = 'COMPLETED', updated_at = NOW() WHERE id = $1`,
        [currentJob.id]
      );
      return true;
    } catch (err: any) {
      const retryCount = currentJob.retry_count + 1;
      const isDlq = retryCount >= currentJob.max_retries;
      const nextDelay = calculateBackoffWithJitter(retryCount);

      const pool = getPool();
      await pool.query(
        `
        UPDATE payment_retry_queue
        SET status = $1,
            retry_count = $2,
            next_retry_at = NOW() + ($3 || ' milliseconds')::INTERVAL,
            lease_expires_at = NULL,
            error_message = $4,
            updated_at = NOW()
        WHERE id = $5
        `,
        [isDlq ? 'DLQ' : 'FAILED', retryCount, nextDelay, err.message, currentJob.id]
      );

      logger.warn({
        action: 'payment_retry_job_failed',
        job_id: currentJob.id,
        retry_count: retryCount,
        is_dlq: isDlq,
        next_delay_ms: nextDelay,
        error: err.message,
        message: 'Retry job failed; scheduled backoff or moved to DLQ'
      });

      return false;
    }
  }

  static async getJob(id: string): Promise<RetryQueueItem | null> {
    const pool = getPool();
    const res = await pool.query(`SELECT * FROM payment_retry_queue WHERE id = $1`, [id]);
    return res.rows[0] || null;
  }
}
