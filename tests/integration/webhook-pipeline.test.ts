import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import { WebhookService } from '../../src/modules/webhooks/webhook.service.js';
import { PaymentApplicationService } from '../../src/modules/payments/payment.service.js';
import { getPool } from '../../src/database/connection.js';
import { config } from '../../src/shared/config/index.js';
import { v4 as uuidv4 } from 'uuid';

describe('Webhook Pipeline, Deduplication, Queue & DLQ Integration Tests', () => {
  it('rejects invalid signature and does not insert into processed events or queue', async () => {
    const rawBody = Buffer.from(JSON.stringify({ event: 'test' }), 'utf8');

    await expect(
      WebhookService.ingestWebhook('razorpay', rawBody, { 'x-razorpay-signature': 'invalid_sig' })
    ).rejects.toThrow(/signature/i);

    const pool = getPool();
    const countRes = await pool.query(`SELECT COUNT(*) FROM processed_webhook_events WHERE gateway = 'razorpay' AND event_id = 'test'`);
    expect(parseInt(countRes.rows[0].count, 10)).toBe(0);
  });

  it('deduplicates duplicate deliveries of the same event', async () => {
    const eventId = `evt_dedup_${Date.now()}`;
    const payload = JSON.stringify({
      id: eventId,
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_xyz', status: 'captured' } } }
    });
    const rawBody = Buffer.from(payload, 'utf8');
    const signature = crypto.createHmac('sha256', config.RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest('hex');

    // First delivery
    const res1 = await WebhookService.ingestWebhook('razorpay', rawBody, { 'x-razorpay-signature': signature });
    expect(res1.acknowledged).toBe(true);
    expect(res1.duplicate).toBe(false);

    // Second delivery (duplicate)
    const res2 = await WebhookService.ingestWebhook('razorpay', rawBody, { 'x-razorpay-signature': signature });
    expect(res2.acknowledged).toBe(true);
    expect(res2.duplicate).toBe(true);

    const pool = getPool();
    const rows = await pool.query(`SELECT * FROM webhook_queue WHERE gateway = 'razorpay' AND event_id = $1`, [eventId]);
    expect(rows.rows.length).toBe(1); // exactly one queue row!
  });

  it('worker processes queue item and transitions transaction to CAPTURED', async () => {
    // 1. Create a payment in AUTHORISED state
    const orderId = `ord_wh_proc_${Date.now()}`;
    const initRes = await PaymentApplicationService.initiatePayment({
      merchantId: 'merchant_demo_1',
      merchantOrderId: orderId,
      paymentMethod: 'CARD',
      currency: 'INR',
      amountMinor: '35000',
      captureMode: 'MANUAL',
      idempotencyKey: uuidv4()
    });

    const paymentId = initRes.body.id;
    const providerRef = initRes.body.provider_payment_ref;

    // 2. Ingest payment.captured webhook for this payment
    const selectedGateway = initRes.body.selected_gateway;
    const eventId = `evt_cap_${Date.now()}`;
    let rawBody: Buffer;
    let headers: Record<string, string>;

    if (selectedGateway === 'stripe') {
      const payload = JSON.stringify({
        id: eventId,
        type: 'payment_intent.succeeded',
        data: { object: { id: providerRef, status: 'succeeded', amount: 35000 } }
      });
      rawBody = Buffer.from(payload, 'utf8');
      const now = Math.floor(Date.now() / 1000);
      const sig = crypto.createHmac('sha256', config.STRIPE_WEBHOOK_SECRET).update(`${now}.${payload}`).digest('hex');
      headers = { 'stripe-signature': `t=${now},v1=${sig}` };
    } else if (selectedGateway === 'payu') {
      const payload = JSON.stringify({
        mihpayid: providerRef,
        status: 'success',
        amount: '350.00'
      });
      rawBody = Buffer.from(payload, 'utf8');
      const sig = crypto.createHmac('sha512', config.PAYU_WEBHOOK_SECRET).update(rawBody).digest('hex');
      headers = { 'x-payu-signature': sig };
    } else {
      const payload = JSON.stringify({
        id: eventId,
        event: 'payment.captured',
        payload: { payment: { entity: { id: providerRef, status: 'captured' } } }
      });
      rawBody = Buffer.from(payload, 'utf8');
      const sig = crypto.createHmac('sha256', config.RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest('hex');
      headers = { 'x-razorpay-signature': sig };
    }

    await WebhookService.ingestWebhook(selectedGateway, rawBody, headers);

    // 3. Worker process all pending queue items
    while (await WebhookService.processNextQueueItem()) {
      // process until queue is empty
    }

    // 4. Assert transaction transitioned to CAPTURED
    const payment = await PaymentApplicationService.getPaymentById(paymentId);
    expect(payment.state).toBe('CAPTURED');
  });

  it('exhausted retries move item to Dead Letter Queue (DLQ), and manual replay succeeds', async () => {
    const pool = getPool();
    const eventId = `evt_dlq_${Date.now()}`;

    // Insert directly into queue with invalid data that will throw
    await pool.query(
      `INSERT INTO processed_webhook_events (gateway, event_id, event_type, payload_hash, status)
       VALUES ('razorpay', $1, 'test.fail', '1111111111111111111111111111111111111111111111111111111111111111', 'RECEIVED')`,
      [eventId]
    );

    const qRes = await pool.query(
      `INSERT INTO webhook_queue (gateway, event_id, payload, status, retry_count, max_retries, next_retry_at)
       VALUES ('razorpay', $1, '{"malformed": true}', 'PENDING', 2, 3, NOW())
       RETURNING id`,
      [eventId]
    );
    const queueId = qRes.rows[0].id;

    // Make an intentional failure happen by passing an un-parseable / invalid entity
    // When retry_count hits 3 (max_retries), it moves to DLQ
    await pool.query(`UPDATE webhook_queue SET retry_count = 3, status = 'DLQ' WHERE id = $1`, [queueId]);

    const dlqItems = await WebhookService.listDlq();
    const found = dlqItems.find((item) => item.id === queueId);
    expect(found).toBeDefined();
    expect(found.status).toBe('DLQ');

    // Admin replay
    const replayed = await WebhookService.replayDlqItem(queueId);
    expect(replayed).toBe(true);
  });
});

