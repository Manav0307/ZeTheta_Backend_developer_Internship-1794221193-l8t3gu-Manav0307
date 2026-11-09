import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import { TransactionRepository } from '../../../src/database/repositories/transaction.repository.js';
import { withTransaction, getPool } from '../../../src/database/connection.js';
import { WebhookService } from '../../../src/modules/webhooks/webhook.service.js';
import { config } from '../../../src/shared/config/index.js';
import { v4 as uuidv4 } from 'uuid';

describe('FS-06: Early Webhook Arrival Before Synchronous API Response', () => {
  beforeEach(async () => {
    const pool = getPool();
    await pool.query('DELETE FROM webhook_queue;');
    await pool.query('DELETE FROM processed_webhook_events;');
  });

  it('handles early webhook arrival gracefully: resolves out-of-order race, maintains CAPTURED state, logs audit record', async () => {
    // 1. Create a payment in AUTH_INITIATED state directly via repo
    const orderId = `ord_fs06_${Date.now()}`;
    const traceId = uuidv4();
    let txId = '';
    const providerRef = `pi_early_${Date.now()}`;

    await withTransaction(async (client) => {
      const tx = await TransactionRepository.create(client, {
        merchant_id: 'merchant_demo_1',
        merchant_order_id: orderId,
        payment_method: 'CARD',
        currency: 'INR',
        amount_minor: '100000',
        capture_mode: 'AUTOMATIC',
        trace_id: traceId
      });
      txId = tx.id;

      await TransactionRepository.transitionState(client, {
        transactionId: tx.id,
        toState: 'ROUTE_SELECTED',
        event: 'ROUTE_SELECT',
        traceId,
        createdBy: 'test_setup'
      });

      await TransactionRepository.transitionState(client, {
        transactionId: tx.id,
        toState: 'AUTH_INITIATED',
        event: 'BEGIN_AUTH',
        traceId,
        createdBy: 'test_setup'
      });

      // Insert active attempt with the providerRef we'll use in the webhook
      await client.query(
        `INSERT INTO payment_attempts (
          id, transaction_id, gateway, attempt_no, status, amount_minor, trace_id, provider_payment_ref
        ) VALUES (gen_random_uuid(), $1, 'razorpay', 1, 'SENT', '100000', $2, $3)`,
        [tx.id, traceId, providerRef]
      );
    });

    // 2. Early webhook arrives FIRST: Razorpay payment.captured
    const eventId = `evt_rzp_early_${Date.now()}`;
    const webhookPayload = JSON.stringify({
      id: eventId,
      entity: 'event',
      account_id: 'acc_demo_1',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: providerRef,
            amount: 100000,
            currency: 'INR',
            status: 'captured',
            order_id: `order_${txId}`
          }
        }
      },
      created_at: Math.floor(Date.now() / 1000)
    });

    const rawBody = Buffer.from(webhookPayload, 'utf8');
    const signature = crypto.createHmac('sha256', config.RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest('hex');

    const webhookResult = await WebhookService.ingestWebhook('razorpay', rawBody, {
      'x-razorpay-signature': signature,
      'x-razorpay-event-id': eventId
    });

    expect(webhookResult.acknowledged).toBe(true);

    // Process the webhook queue item until drained
    while (await WebhookService.processNextQueueItem()) {
      // process all
    }

    // Verify webhook transitioned state to CAPTURED
    const pool = getPool();
    const afterWebhook = await TransactionRepository.findById(pool, txId);
    expect(afterWebhook?.state).toBe('CAPTURED');

    // 3. Late synchronous response arrives: Attempts to transition to AUTHORISED
    // Repository detects transaction is already CAPTURED and resolves out-of-order race idempotently
    const resolvedTx = await withTransaction(async (client) => {
      return TransactionRepository.transitionState(client, {
        transactionId: txId,
        toState: 'AUTHORISED',
        event: 'AUTH_SUCCESS',
        traceId: uuidv4(),
        createdBy: 'sync_response_handler',
        gatewayReference: providerRef
      });
    });

    // Must NOT revert to AUTHORISED; remains CAPTURED
    expect(resolvedTx.state).toBe('CAPTURED');

    // Verify audit log recorded OUT_OF_ORDER_RESOLUTION
    const logRes = await pool.query(
      `SELECT * FROM transaction_state_log WHERE transaction_id = $1 AND event = 'OUT_OF_ORDER_RESOLUTION'`,
      [txId]
    );
    expect(logRes.rows.length).toBe(1);
    expect(logRes.rows[0].metadata.note).toContain('Out-of-order race resolved');
  });
});
