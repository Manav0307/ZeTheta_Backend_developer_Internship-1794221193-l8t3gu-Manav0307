import crypto from 'crypto';
import pg from 'pg';
import { withTransaction, getPool } from '../../database/connection.js';
import { GatewayRegistry } from '../../gateways/registry.js';
import { TransactionRepository } from '../../database/repositories/transaction.repository.js';
import { PaymentAttemptRepository } from '../../database/repositories/attempt.repository.js';
import { BadRequestError, NotFoundError, UnauthorizedError } from '../../shared/errors/index.js';
import { logger } from '../../shared/logging/logger.js';
import { config } from '../../shared/config/index.js';


export class WebhookService {
  private static getSecret(gateway: string): string {
    switch (gateway.toLowerCase()) {
      case 'razorpay':
        return config.RAZORPAY_WEBHOOK_SECRET;
      case 'stripe':
        return config.STRIPE_WEBHOOK_SECRET;
      case 'payu':
        return config.PAYU_WEBHOOK_SECRET;
      case 'upi':
        return config.UPI_WEBHOOK_SECRET;
      default:
        return 'mock-default-secret';
    }
  }

  static async ingestWebhook(
    gatewayName: string,
    rawBody: Buffer,
    headers: Record<string, unknown>
  ): Promise<{ acknowledged: boolean; duplicate: boolean; eventId: string }> {
    const adapter = GatewayRegistry.get(gatewayName);
    const secret = this.getSecret(gatewayName);

    // 1. Raw body cryptographic verification
    const verified = adapter.verifyWebhook(rawBody, headers, secret);
    if (!verified.isValid) {
      logger.warn({
        gateway: gatewayName,
        action: 'webhook_verification_failed',
        error: verified.error,
        message: 'Webhook signature verification failed'
      });
      throw new UnauthorizedError(
        `Webhook signature verification failed: ${verified.error || 'invalid signature'}`,
        'WEBHOOK_SIGNATURE_INVALID'
      );
    }
    const payloadHash = crypto.createHash('sha256').update(rawBody).digest('hex');

    // 2. Atomic Deduplication & Durable Queue Insert in ONE SQL transaction
    let isDuplicate = false;

    await withTransaction(async (client) => {
      // Check existing event in processed_webhook_events
      const existing = await client.query(
        `SELECT * FROM processed_webhook_events WHERE gateway = $1 AND event_id = $2 FOR UPDATE`,
        [gatewayName, verified.eventId]
      );

      if (existing.rowCount && existing.rowCount > 0) {
        isDuplicate = true;
        return; // Acknowledge duplicate without creating another queue job
      }

      // Try resolving transaction / attempt by provider payment ref
      let transactionId: string | null = null;
      let attemptId: string | null = null;

      if (verified.providerPaymentRef) {
        const attempt = await PaymentAttemptRepository.findByProviderRef(
          client,
          gatewayName,
          verified.providerPaymentRef
        );
        if (attempt) {
          attemptId = attempt.id;
          transactionId = attempt.transaction_id;
        }
      }

      // Insert processed_webhook_events
      await client.query(
        `
        INSERT INTO processed_webhook_events (
          gateway, event_id, event_type, payload_hash, transaction_id, attempt_id, status
        ) VALUES ($1, $2, $3, $4, $5, $6, 'RECEIVED')
      `,
        [
          gatewayName,
          verified.eventId,
          verified.eventType,
          payloadHash,
          transactionId,
          attemptId
        ]
      );

      // Insert webhook_queue
      await client.query(
        `
        INSERT INTO webhook_queue (
          gateway, event_id, transaction_id, attempt_id, payload, signature_digest, status, next_retry_at
        ) VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', NOW())
      `,
        [
          gatewayName,
          verified.eventId,
          transactionId,
          attemptId,
          JSON.stringify(verified.payload),
          payloadHash
        ]
      );
    });

    logger.info({
      gateway: gatewayName,
      action: 'webhook_ingested',
      eventId: verified.eventId,
      isDuplicate,
      message: `Webhook ${verified.eventId} ingested from ${gatewayName} (duplicate=${isDuplicate})`
    });

    return {
      acknowledged: true,
      duplicate: isDuplicate,
      eventId: verified.eventId
    };
  }

  static async processNextQueueItem(): Promise<boolean> {
    const pool = getPool();
    let queueItem: any = null;

    // 1. Claim next pending job using FOR UPDATE SKIP LOCKED
    await withTransaction(async (client) => {
      const res = await client.query(
        `
        SELECT * FROM webhook_queue
        WHERE (status = 'PENDING' OR (status = 'FAILED' AND next_retry_at <= NOW()))
           OR (status = 'PROCESSING' AND lease_expires_at < NOW())
        ORDER BY id ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `
      );

      if (res.rowCount && res.rowCount > 0) {
        queueItem = res.rows[0];
        await client.query(
          `
          UPDATE webhook_queue
          SET status = 'PROCESSING',
              lease_expires_at = NOW() + INTERVAL '30 seconds'
          WHERE id = $1
        `,
          [queueItem.id]
        );
      }
    });

    if (!queueItem) {
      return false; // Queue empty
    }

    // 2. Process the event
    try {
      await withTransaction(async (client) => {
        const rawPayload = queueItem.payload;
        const payload = typeof rawPayload === 'string' ? JSON.parse(rawPayload) : rawPayload;
        const gateway = queueItem.gateway;

        // Correlate with attempt & transaction
        let txId = queueItem.transaction_id;
        let attId = queueItem.attempt_id;

        if (!txId) {
          const providerRef =
            payload.id ||
            payload.payload?.payment?.entity?.id ||
            payload.data?.object?.id ||
            payload.mihpayid ||
            payload.txnId;

          if (providerRef) {
            const attempt = await PaymentAttemptRepository.findByProviderRef(client, gateway, providerRef);
            if (attempt) {
              txId = attempt.transaction_id;
              attId = attempt.id;
            }
          }
        }

        if (txId) {
          const tx = await TransactionRepository.lockForUpdate(client, txId);

          // Apply state transition if admissible
          const eventType = String(payload.event || payload.type || queueItem.event_id || '').toLowerCase();
          const payloadStatus = String(payload.status || payload.payload?.payment?.entity?.status || payload.data?.object?.status || '').toLowerCase();

          if (
            (payloadStatus === 'captured' || payloadStatus === 'succeeded' || payloadStatus === 'success' || eventType.includes('capture') || eventType.includes('succeeded')) &&
            (tx.state === 'AUTHORISED' || tx.state === 'CAPTURE_INITIATED' || tx.state === 'AUTH_INITIATED')
          ) {
            await TransactionRepository.transitionState(client, {
              transactionId: tx.id,
              toState: 'CAPTURED',
              event: 'CAPTURE_COMPLETE',
              traceId: tx.trace_id,
              createdBy: 'webhook_worker',
              attemptId: attId,
              gatewayResponse: payload,
              authorized_minor: tx.amount_minor,
              captured_minor: tx.amount_minor
            });



            if (attId) {
              await PaymentAttemptRepository.updateStatus(client, {
                attempt_id: attId,
                status: 'CAPTURED'
              });
            }
          } else if (
            (payloadStatus === 'authorized' || payloadStatus === 'requires_capture') &&
            tx.state === 'AUTH_INITIATED'
          ) {
            await TransactionRepository.transitionState(client, {
              transactionId: tx.id,
              toState: 'AUTHORISED',
              event: 'AUTH_SUCCESS',
              traceId: tx.trace_id,
              createdBy: 'webhook_worker',
              attemptId: attId,
              gatewayResponse: payload,
              authorized_minor: tx.amount_minor
            });
            if (attId) {
              await PaymentAttemptRepository.updateStatus(client, {
                attempt_id: attId,
                status: 'AUTHORISED'
              });
            }
          }
        }

        // Mark COMPLETED in webhook_queue and PROCESSED in processed_webhook_events
        await client.query(
          `
          UPDATE webhook_queue
          SET status = 'COMPLETED',
              processed_at = NOW(),
              transaction_id = COALESCE($1, transaction_id),
              attempt_id = COALESCE($2, attempt_id)
          WHERE id = $3
        `,
          [txId || null, attId || null, queueItem.id]
        );

        await client.query(
          `
          UPDATE processed_webhook_events
          SET status = 'PROCESSED',
              processed_at = NOW(),
              transaction_id = COALESCE($1, transaction_id),
              attempt_id = COALESCE($2, attempt_id)
          WHERE gateway = $3 AND event_id = $4
        `,
          [txId || null, attId || null, queueItem.gateway, queueItem.event_id]
        );
      });

      return true;
    } catch (err: any) {
      console.error('Webhook processing failed with error:', err);
      // 3. Retry or DLQ handling

      await withTransaction(async (client) => {
        const retryCount = queueItem.retry_count + 1;
        const maxRetries = queueItem.max_retries || 3;
        const isDlq = retryCount >= maxRetries;

        const nextRetrySeconds = Math.pow(2, retryCount) * 5; // Exponential backoff: 10s, 20s, 40s

        await client.query(
          `
          UPDATE webhook_queue
          SET status = $1,
              retry_count = $2,
              next_retry_at = NOW() + ($3 || ' seconds')::INTERVAL,
              error_message = $4,
              lease_expires_at = NULL
          WHERE id = $5
        `,
          [isDlq ? 'DLQ' : 'FAILED', retryCount, nextRetrySeconds, err.message, queueItem.id]
        );

        if (isDlq) {
          await client.query(
            `
            UPDATE processed_webhook_events
            SET status = 'DLQ'
            WHERE gateway = $1 AND event_id = $2
          `,
            [queueItem.gateway, queueItem.event_id]
          );

          logger.error({
            gateway: queueItem.gateway,
            eventId: queueItem.event_id,
            error: err.message,
            message: `Webhook event moved to DEAD-LETTER QUEUE after ${retryCount} retries`
          });
        }
      });

      return true;
    }
  }

  static async listDlq(): Promise<any[]> {
    const pool = getPool();
    const res = await pool.query(
      `SELECT * FROM webhook_queue WHERE status = 'DLQ' ORDER BY created_at DESC`
    );
    return res.rows;
  }

  static async replayDlqItem(id: string): Promise<boolean> {
    const pool = getPool();
    const res = await pool.query(
      `
      UPDATE webhook_queue
      SET status = 'PENDING',
          retry_count = 0,
          next_retry_at = NOW(),
          error_message = NULL
      WHERE id = $1 AND status = 'DLQ'
      RETURNING *
    `,
      [id]
    );

    if (res.rowCount === 0) {
      throw new NotFoundError(`DLQ item with ID ${id} not found`, 'DLQ_ITEM_NOT_FOUND');
    }

    await this.processNextQueueItem();
    return true;
  }

  static async processQueueBatch(limit: number = 10): Promise<number> {
    let processed = 0;
    for (let i = 0; i < limit; i++) {
      const didProcess = await this.processNextQueueItem();
      if (!didProcess) break;
      processed++;
    }
    return processed;
  }
}

