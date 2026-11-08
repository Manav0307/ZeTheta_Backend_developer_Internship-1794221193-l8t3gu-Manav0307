import { describe, it, expect, beforeEach } from 'vitest';
import { PaymentApplicationService } from '../../src/modules/payments/payment.service.js';
import { MockGatewayController } from '../../src/gateways/mocks/index.js';
import { v4 as uuidv4 } from 'uuid';

describe('Payment Full Lifecycle Integration Tests', () => {
  beforeEach(() => {
    MockGatewayController.reset();
  });

  it('Happy path: Card authorisation then full capture with state audit trail', async () => {
    const orderId = `ord_lc_${Date.now()}_1`;
    const idemKey = uuidv4();

    // 1. Initiate Card Payment (Manual capture mode -> AUTHORISED)
    const initRes = await PaymentApplicationService.initiatePayment({
      merchantId: 'merchant_demo_1',
      merchantOrderId: orderId,
      paymentMethod: 'CARD',
      currency: 'INR',
      amountMinor: '50000', // ₹500.00
      captureMode: 'MANUAL',
      idempotencyKey: idemKey
    });

    expect(initRes.statusCode).toBe(201);
    expect(initRes.body.state).toBe('AUTHORISED');
    const paymentId = initRes.body.id;

    // 2. Capture Payment
    const capRes = await PaymentApplicationService.capturePayment({
      merchantId: 'merchant_demo_1',
      transactionId: paymentId,
      amountMinor: '50000',
      idempotencyKey: uuidv4()
    });

    expect(capRes.statusCode).toBe(200);
    expect(capRes.body.state).toBe('CAPTURED');
    expect(capRes.body.captured_minor).toBe('50000');

    // 3. Verify Immutable Timeline
    const timeline = await PaymentApplicationService.getTimeline(paymentId);
    expect(timeline.length).toBeGreaterThanOrEqual(4);
    const states = timeline.map((t) => t.to_state);
    expect(states).toContain('CREATED');
    expect(states).toContain('ROUTE_SELECTED');
    expect(states).toContain('AUTH_INITIATED');
    expect(states).toContain('AUTHORISED');
    expect(states).toContain('CAPTURE_INITIATED');
    expect(states).toContain('CAPTURED');
  });

  it('Supports partial capture and remainder capture', async () => {
    const orderId = `ord_partial_${Date.now()}`;
    const initRes = await PaymentApplicationService.initiatePayment({
      merchantId: 'merchant_demo_1',
      merchantOrderId: orderId,
      paymentMethod: 'CARD',
      currency: 'INR',
      amountMinor: '100000', // ₹1000.00
      captureMode: 'MANUAL',
      idempotencyKey: uuidv4()
    });

    const paymentId = initRes.body.id;

    // Partial capture 1: ₹400.00 (40000)
    const cap1 = await PaymentApplicationService.capturePayment({
      merchantId: 'merchant_demo_1',
      transactionId: paymentId,
      amountMinor: '40000',
      idempotencyKey: uuidv4()
    });
    expect(cap1.body.state).toBe('PARTIALLY_CAPTURED');
    expect(cap1.body.captured_minor).toBe('40000');

    // Remainder capture 2: ₹600.00 (60000)
    const cap2 = await PaymentApplicationService.capturePayment({
      merchantId: 'merchant_demo_1',
      transactionId: paymentId,
      amountMinor: '60000',
      idempotencyKey: uuidv4()
    });
    expect(cap2.body.state).toBe('CAPTURED');
    expect(cap2.body.captured_minor).toBe('100000');
  });

  it('Instant UPI payment is CAPTURED without requiring separate capture', async () => {
    const orderId = `ord_upi_${Date.now()}`;
    const res = await PaymentApplicationService.initiatePayment({
      merchantId: 'merchant_demo_1',
      merchantOrderId: orderId,
      paymentMethod: 'UPI',
      currency: 'INR',
      amountMinor: '25000', // ₹250.00
      idempotencyKey: uuidv4()
    });

    expect(res.statusCode).toBe(201);
    expect(res.body.state).toBe('CAPTURED');
  });

  it('Supports voiding an authorised hold', async () => {
    const orderId = `ord_void_${Date.now()}`;
    const initRes = await PaymentApplicationService.initiatePayment({
      merchantId: 'merchant_demo_1',
      merchantOrderId: orderId,
      paymentMethod: 'CARD',
      currency: 'INR',
      amountMinor: '30000',
      captureMode: 'MANUAL',
      idempotencyKey: uuidv4()
    });

    const paymentId = initRes.body.id;
    const voidRes = await PaymentApplicationService.voidPayment({
      merchantId: 'merchant_demo_1',
      transactionId: paymentId,
      idempotencyKey: uuidv4()
    });

    expect(voidRes.statusCode).toBe(200);
    expect(voidRes.body.state).toBe('VOIDED');
  });

  it('Partial and full refunds correctly track captured and refunded balances', async () => {
    const orderId = `ord_refund_${Date.now()}`;
    const initRes = await PaymentApplicationService.initiatePayment({
      merchantId: 'merchant_demo_1',
      merchantOrderId: orderId,
      paymentMethod: 'CARD',
      currency: 'INR',
      amountMinor: '50000',
      captureMode: 'MANUAL',
      idempotencyKey: uuidv4()
    });
    const paymentId = initRes.body.id;

    await PaymentApplicationService.capturePayment({
      merchantId: 'merchant_demo_1',
      transactionId: paymentId,
      amountMinor: '50000',
      idempotencyKey: uuidv4()
    });

    // Partial refund 1: ₹200.00
    const ref1 = await PaymentApplicationService.refundPayment({
      merchantId: 'merchant_demo_1',
      transactionId: paymentId,
      amountMinor: '20000',
      reason: 'Partial return',
      idempotencyKey: uuidv4()
    });
    expect(ref1.body.state).toBe('PARTIALLY_REFUNDED');
    expect(ref1.body.refunded_minor).toBe('20000');

    // Partial refund 2: ₹300.00 (remaining balance -> full refund!)
    const ref2 = await PaymentApplicationService.refundPayment({
      merchantId: 'merchant_demo_1',
      transactionId: paymentId,
      amountMinor: '30000',
      reason: 'Remainder return',
      idempotencyKey: uuidv4()
    });
    expect(ref2.body.state).toBe('REFUNDED');
    expect(ref2.body.refunded_minor).toBe('50000');
  });

  it('Rejects refund if requested amount exceeds captured balance', async () => {
    const orderId = `ord_overref_${Date.now()}`;
    const initRes = await PaymentApplicationService.initiatePayment({
      merchantId: 'merchant_demo_1',
      merchantOrderId: orderId,
      paymentMethod: 'CARD',
      currency: 'INR',
      amountMinor: '20000',
      captureMode: 'MANUAL',
      idempotencyKey: uuidv4()
    });
    const paymentId = initRes.body.id;

    await PaymentApplicationService.capturePayment({
      merchantId: 'merchant_demo_1',
      transactionId: paymentId,
      amountMinor: '20000',
      idempotencyKey: uuidv4()
    });

    await expect(
      PaymentApplicationService.refundPayment({
        merchantId: 'merchant_demo_1',
        transactionId: paymentId,
        amountMinor: '30000', // exceeds 20000!
        idempotencyKey: uuidv4()
      })
    ).rejects.toThrow(/exceeds/i);
  });
});

