import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../../src/app.js';
import { PaymentApplicationService } from '../../../src/modules/payments/payment.service.js';
import { MockGatewayController } from '../../../src/gateways/mocks/index.js';
import { config } from '../../../src/shared/config/index.js';
import { v4 as uuidv4 } from 'uuid';

describe('FS-05: Partial Capture and Remainder Hold Handling', () => {
  const app = createApp();

  beforeEach(() => {
    MockGatewayController.reset();
  });

  it('partially captures ₹800 of ₹1200 authorized payment and allows releasing remainder hold', async () => {
    // 1. Authorize ₹1200 (120000 minor)
    const orderId = `ord_fs05_${Date.now()}`;
    const payment = await PaymentApplicationService.initiatePayment({
      merchantId: 'merchant_demo_1',
      merchantOrderId: orderId,
      paymentMethod: 'CARD',
      currency: 'INR',
      amountMinor: '120000',
      captureMode: 'MANUAL',
      idempotencyKey: uuidv4()
    });

    expect(payment.statusCode).toBe(201);
    expect(payment.body.state).toBe('AUTHORISED');
    const paymentId = payment.body.id;

    // 2. Partially capture ₹800 (80000 minor)
    const captureRes = await request(app)
      .post(`/api/v1/payments/${paymentId}/capture`)
      .set('x-merchant-id', 'merchant_demo_1')
      .set('x-api-key', config.MERCHANT_API_KEY)
      .set('idempotency-key', uuidv4())
      .send({ amount_minor: '80000' });

    expect(captureRes.status).toBe(200);
    expect(captureRes.body.state).toBe('PARTIALLY_CAPTURED');
    expect(captureRes.body.authorized_minor).toBe('120000');
    expect(captureRes.body.captured_minor).toBe('80000');

    // 3. Void remaining ₹400 hold via void-remainder endpoint
    const voidRes = await request(app)
      .post(`/api/v1/payments/${paymentId}/void-remainder`)
      .set('x-merchant-id', 'merchant_demo_1')
      .set('x-api-key', config.MERCHANT_API_KEY)
      .send();

    expect(voidRes.status).toBe(200);
    expect(voidRes.body.state).toBe('CAPTURED');
    expect(voidRes.body.authorized_minor).toBe('80000');
    expect(voidRes.body.captured_minor).toBe('80000');

    // Verify timeline
    const timelineRes = await request(app)
      .get(`/api/v1/payments/${paymentId}/timeline`)
      .set('x-merchant-id', 'merchant_demo_1')
      .set('x-api-key', config.MERCHANT_API_KEY);

    expect(timelineRes.status).toBe(200);
    const events = timelineRes.body.timeline.map((e: any) => e.event);
    expect(events).toContain('CAPTURE_PARTIAL');
    expect(events).toContain('RELEASE_REMAINDER');
  });
});

