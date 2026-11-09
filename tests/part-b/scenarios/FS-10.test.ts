import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../../src/app.js';
import { PaymentApplicationService } from '../../../src/modules/payments/payment.service.js';
import { v4 as uuidv4 } from 'uuid';

describe('FS-10: Webhook Tampering & Signature Verification Failure', () => {
  const app = createApp();

  it('rejects tampered webhook payload with invalid signature (401) and preserves payment state', async () => {
    // 1. Create a payment in AUTHORISED state
    const orderId = `ord_fs10_${Date.now()}`;
    const payment = await PaymentApplicationService.initiatePayment({
      merchantId: 'merchant_demo_1',
      merchantOrderId: orderId,
      paymentMethod: 'CARD',
      currency: 'INR',
      amountMinor: '50000',
      captureMode: 'MANUAL',
      idempotencyKey: uuidv4()
    });

    const paymentId = payment.body.id;
    const providerRef = payment.body.provider_payment_ref;

    // 2. Attacker prepares payload with amount altered from 50000 to 5000000
    const tamperedPayload = {
      entity: 'event',
      account_id: 'acc_demo_1',
      event: 'payment.captured',
      contains: ['payment'],
      payload: {
        payment: {
          entity: {
            id: providerRef,
            amount: 5000000, // Altered amount!
            currency: 'INR',
            status: 'captured'
          }
        }
      }
    };

    const rawBody = Buffer.from(JSON.stringify(tamperedPayload));
    // Forged invalid signature (not HMAC-SHA256 of real body with real secret)
    const forgedSignature = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    const res = await request(app)
      .post('/api/v1/webhooks/razorpay')
      .set('x-razorpay-signature', forgedSignature)
      .set('x-razorpay-event-id', `evt_tampered_${Date.now()}`)
      .set('Content-Type', 'application/json')
      .send(rawBody);

    // Must be rejected with 401 Unauthorized
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('WEBHOOK_SIGNATURE_INVALID');

    // 3. Verify payment state in DB is completely untouched
    const tx = await PaymentApplicationService.getPaymentById(paymentId, 'merchant_demo_1');
    expect(tx.state).toBe('AUTHORISED');
    expect(tx.captured_minor).toBe('0');
  });
});
