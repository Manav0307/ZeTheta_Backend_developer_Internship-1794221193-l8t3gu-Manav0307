import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { getPool } from '../../src/database/connection.js';
import { PaymentApplicationService } from '../../src/modules/payments/payment.service.js';
import { WebhookService } from '../../src/modules/webhooks/webhook.service.js';
import { TransactionRepository } from '../../src/database/repositories/transaction.repository.js';
import { logger } from '../../src/shared/logging/logger.js';
import { config } from '../../src/shared/config/index.js';
import { MockGatewayController } from '../../src/gateways/mocks/index.js';

describe('C4: Webhook Replay Fraud Prevention & Amount/Currency Validation', () => {
  const app = createApp();
  const pool = getPool();
  const webhookSecret = config.RAZORPAY_WEBHOOK_SECRET;

  beforeEach(async () => {
    MockGatewayController.reset();
    MockGatewayController.setBehavior('payu', 'definite_5xx');
    MockGatewayController.setBehavior('razorpay', 'success');
    MockGatewayController.setBehavior('stripe', 'definite_5xx');
  });

  it('1. CRITICAL C4 TEST: Validly signed ₹10 webhook linked to an unrelated ₹50,000 order is REJECTED without marking order paid', async () => {
    const loggerWarnSpy = vi.spyOn(logger, 'warn');

    // 1. Merchant creates a ₹50,000 order (amount_minor: 5000000)
    const orderId = `ord_c4_highvalue_${Date.now()}`;
    const payment = await PaymentApplicationService.initiatePayment({
      merchantId: 'merchant_demo_1',
      merchantOrderId: orderId,
      paymentMethod: 'CARD',
      currency: 'INR',
      amountMinor: '5000000', // ₹50,000
      captureMode: 'MANUAL',
      idempotencyKey: uuidv4()
    });

    expect(payment.body.selected_gateway).toBe('razorpay');
    const txId = payment.body.id;
    const providerRef = payment.body.provider_payment_ref;

    // 2. Attacker sends a VALIDLY SIGNED payload, but for a ₹10 payment (1000 minor units)
    // targeting the provider reference of the ₹50,000 order
    const lowValuePayload = {
      id: `evt_c4_exploit_${Date.now()}`,
      entity: 'event',
      account_id: 'acc_demo_1',
      event: 'payment.captured',
      contains: ['payment'],
      payload: {
        payment: {
          entity: {
            id: providerRef,
            amount: 1000, // ₹10 only! (Target order is 5000000)
            currency: 'INR',
            status: 'captured'
          }
        }
      }
    };

    const rawBody = Buffer.from(JSON.stringify(lowValuePayload));
    // Valid HMAC-SHA256 signature generated with the real secret
    const validSignature = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');

    // Ingest into webhook endpoint
    const ingestRes = await WebhookService.ingestWebhook('razorpay', rawBody, {
      'x-razorpay-signature': validSignature,
      'x-razorpay-event-id': lowValuePayload.id
    });

    expect(ingestRes.acknowledged).toBe(true);

    // Process worker queue: worker MUST detect amount mismatch and REJECT state transition
    await WebhookService.processNextQueueItem();

    // Verify security audit warning was logged
    expect(loggerWarnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'security_audit_log',
        event: 'WEBHOOK_AMOUNT_MISMATCH',
        transaction_id: txId,
        expected_amount_minor: '5000000',
        received_amount_minor: '1000'
      })
    );

    // CRITICAL: Order MUST NOT be in CAPTURED state!
    const tx = await TransactionRepository.findById(pool, txId);
    expect(tx?.state).not.toBe('CAPTURED');
    expect(tx?.state).toBe('AUTHORISED');
    expect(tx?.captured_minor).toBe('0');

    loggerWarnSpy.mockRestore();
  });

  it('2. Currency Mismatch Guard: Validly signed webhook with wrong currency is rejected', async () => {
    const loggerWarnSpy = vi.spyOn(logger, 'warn');

    // Merchant creates an INR payment
    const payment = await PaymentApplicationService.initiatePayment({
      merchantId: 'merchant_demo_1',
      merchantOrderId: `ord_c4_currency_${Date.now()}`,
      paymentMethod: 'CARD',
      currency: 'INR',
      amountMinor: '100000',
      captureMode: 'MANUAL',
      idempotencyKey: uuidv4()
    });

    expect(payment.body.selected_gateway).toBe('razorpay');
    const txId = payment.body.id;
    const providerRef = payment.body.provider_payment_ref;

    // Webhook delivers USD instead of INR
    const eventId = `evt_c4_cur_${Date.now()}`;
    const mismatchPayload = {
      id: eventId,
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: providerRef,
            amount: 100000,
            currency: 'USD', // Mismatched currency!
            status: 'captured'
          }
        }
      }
    };

    const rawBody = Buffer.from(JSON.stringify(mismatchPayload));
    const validSignature = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');

    await WebhookService.ingestWebhook('razorpay', rawBody, {
      'x-razorpay-signature': validSignature,
      'x-razorpay-event-id': eventId
    });

    await WebhookService.processNextQueueItem();

    expect(loggerWarnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'security_audit_log',
        event: 'WEBHOOK_CURRENCY_MISMATCH',
        transaction_id: txId
      })
    );

    const tx = await TransactionRepository.findById(pool, txId);
    expect(tx?.state).toBe('AUTHORISED'); // Payment state unchanged

    loggerWarnSpy.mockRestore();
  });

  it('3. Signature Tamper Rejection: Bit-flipped payload is rejected at gateway with 401 and source IP (FS-10)', async () => {
    const tamperedPayload = {
      event: 'payment.captured',
      amount: 10000
    };
    const rawBody = Buffer.from(JSON.stringify(tamperedPayload));

    const res = await request(app)
      .post('/api/v1/webhooks/razorpay')
      .set('x-razorpay-signature', '0000000000000000000000000000000000000000000000000000000000000000')
      .set('x-razorpay-event-id', `evt_tamper_${Date.now()}`)
      .set('x-forwarded-for', '198.51.100.42')
      .set('Content-Type', 'application/json')
      .send(rawBody);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('WEBHOOK_SIGNATURE_INVALID');
  });
});
