import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import { PaymentApplicationService } from '../../../src/modules/payments/payment.service.js';
import { WebhookService } from '../../../src/modules/webhooks/webhook.service.js';
import { MockGatewayController } from '../../../src/gateways/mocks/index.js';
import { getPool } from '../../../src/database/connection.js';
import { config } from '../../../src/shared/config/index.js';
import { v4 as uuidv4 } from 'uuid';

describe('FS-02: Duplicate Webhook Delivery 3x', () => {
  beforeEach(async () => {
    MockGatewayController.reset();
    const pool = getPool();
    await pool.query("UPDATE gateway_circuit_breakers SET state = 'CLOSED', consecutive_failures = 0, opened_until = NULL;");
    // Route to Razorpay by setting PayU breaker OPEN
    await pool.query("UPDATE gateway_circuit_breakers SET state = 'OPEN', opened_until = NOW() + INTERVAL '10 min' WHERE gateway = 'payu';");
    await pool.query("DELETE FROM webhook_queue;");
    await pool.query("DELETE FROM processed_webhook_events;");
  });

  it('delivers identical payment.captured webhook 3 times: all acknowledged, exactly 1 state transition, no duplicate charges', async () => {
    // 1. Create a payment in AUTHORISED state routed to Razorpay
    const orderId = `ord_fs02_${Date.now()}`;
    const paymentRes = await PaymentApplicationService.initiatePayment({
      merchantId: 'merchant_demo_1',
      merchantOrderId: orderId,
      paymentMethod: 'CARD',
      currency: 'INR',
      amountMinor: '100000',
      captureMode: 'MANUAL',
      idempotencyKey: uuidv4()
    });

    expect(paymentRes.body.state).toBe('AUTHORISED');
    expect(paymentRes.body.selected_gateway).toBe('razorpay');
    const paymentId = paymentRes.body.id;
    const providerRef = paymentRes.body.provider_payment_ref;

    // 2. Prepare Razorpay payment.captured webhook
    const eventId = `evt_rzp_dup_${Date.now()}`;
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
            order_id: `order_${paymentId}`
          }
        }
      },
      created_at: Math.floor(Date.now() / 1000)
    });

    const rawBody = Buffer.from(webhookPayload, 'utf8');
    const signature = crypto.createHmac('sha256', config.RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest('hex');

    // 3. Ingest webhook 3 times sequentially
    for (let i = 1; i <= 3; i++) {
      const res = await WebhookService.ingestWebhook('razorpay', rawBody, {
        'x-razorpay-signature': signature,
        'x-razorpay-event-id': eventId
      });

      expect(res.acknowledged).toBe(true);
      if (i === 1) {
        expect(res.duplicate).toBe(false);
      } else {
        expect(res.duplicate).toBe(true);
      }
    }

    // 4. Process webhook queue worker until drained
    while (await WebhookService.processNextQueueItem()) {
      // process all
    }

    // 5. Verify transaction state is CAPTURED
    const payment = await PaymentApplicationService.getPaymentById(paymentId, 'merchant_demo_1');
    expect(payment.state).toBe('CAPTURED');
    expect(payment.captured_minor).toBe('100000');

    // 6. Verify audit log: exactly 1 CAPTURE_COMPLETE transition
    const pool = getPool();
    const logRes = await pool.query(
      `SELECT * FROM transaction_state_log WHERE transaction_id = $1 AND to_state = 'CAPTURED'`,
      [paymentId]
    );
    expect(logRes.rows.length).toBe(1);

    // 7. Verify exactly 1 row in webhook_queue
    const queueRes = await pool.query(
      `SELECT * FROM webhook_queue WHERE gateway = 'razorpay' AND event_id = $1`,
      [eventId]
    );
    expect(queueRes.rows.length).toBe(1);
  });
});
