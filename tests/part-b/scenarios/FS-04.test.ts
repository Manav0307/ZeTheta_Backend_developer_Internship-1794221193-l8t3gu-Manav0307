import { describe, it, expect, beforeEach } from 'vitest';
import { PaymentApplicationService } from '../../../src/modules/payments/payment.service.js';
import { MockGatewayController } from '../../../src/gateways/mocks/index.js';
import { MockStateStore } from '../../../src/modules/gateway-mocks/mock-state.store.js';
import { v4 as uuidv4 } from 'uuid';

describe('FS-04: 502 Bad Gateway During Capture with Exponential Backoff', () => {
  beforeEach(() => {
    MockGatewayController.reset();
    MockStateStore.reset();
    process.env.TEST_FAST_RETRIES = 'true'; // Fast backoff in automated test suite
  });

  it('retries on 502 with exponential backoff and transitions to CAPTURED when 3rd attempt succeeds', async () => {
    // 1. Create AUTHORISED payment on PayU
    const orderId = `ord_fs04_retry_${Date.now()}`;
    const payment = await PaymentApplicationService.initiatePayment({
      merchantId: 'merchant_demo_1',
      merchantOrderId: orderId,
      paymentMethod: 'CARD',
      currency: 'INR',
      amountMinor: '100000',
      captureMode: 'MANUAL',
      idempotencyKey: uuidv4()
    });

    expect(payment.body.state).toBe('AUTHORISED');
    const paymentId = payment.body.id;
    const providerRef = payment.body.provider_payment_ref;

    // 2. Configure PayU capture to fail first 2 attempts with 502, succeed on 3rd
    MockStateStore.setScenarioParam('payu_capture_fail_count', 2);

    // 3. Trigger capture
    const captureRes = await PaymentApplicationService.capturePayment({
      merchantId: 'merchant_demo_1',
      transactionId: paymentId,
      amountMinor: '100000',
      idempotencyKey: uuidv4()
    });

    expect(captureRes.statusCode).toBe(200);
    expect(captureRes.body.state).toBe('CAPTURED');
    expect(captureRes.body.captured_minor).toBe('100000');

    // Verify 3 capture attempts took place
    const attempts = MockStateStore.getScenarioParam<number>(`payu_capture_attempts_${providerRef}`);
    expect(attempts).toBe(3);
  });

  it('exhausts retries and transitions to CAPTURE_FAILED when gateway confirms uncaptured hold', async () => {
    const orderId = `ord_fs04_failed_${Date.now()}`;
    const payment = await PaymentApplicationService.initiatePayment({
      merchantId: 'merchant_demo_1',
      merchantOrderId: orderId,
      paymentMethod: 'CARD',
      currency: 'INR',
      amountMinor: '100000',
      captureMode: 'MANUAL',
      idempotencyKey: uuidv4()
    });

    const paymentId = payment.body.id;
    const providerRef = payment.body.provider_payment_ref;

    // Fail all attempts
    MockStateStore.setScenarioParam('payu_capture_fail_count', 10);
    MockStateStore.setScenarioParam(`status_${providerRef}`, 'AUTHORISED');

    await expect(
      PaymentApplicationService.capturePayment({
        merchantId: 'merchant_demo_1',
        transactionId: paymentId,
        amountMinor: '100000',
        idempotencyKey: uuidv4()
      })
    ).rejects.toThrow();

    const updatedTx = await PaymentApplicationService.getPaymentById(paymentId, 'merchant_demo_1');
    expect(updatedTx.state).toBe('CAPTURE_FAILED');
  });

  it('reconciles late capture success if status query returns CAPTURED after retries', async () => {
    const orderId = `ord_fs04_late_${Date.now()}`;
    const payment = await PaymentApplicationService.initiatePayment({
      merchantId: 'merchant_demo_1',
      merchantOrderId: orderId,
      paymentMethod: 'CARD',
      currency: 'INR',
      amountMinor: '100000',
      captureMode: 'MANUAL',
      idempotencyKey: uuidv4()
    });

    const paymentId = payment.body.id;
    const providerRef = payment.body.provider_payment_ref;

    // Capture calls fail with 502, but late status check finds CAPTURED
    MockStateStore.setScenarioParam('payu_capture_fail_count', 10);
    MockStateStore.setScenarioParam(`status_${providerRef}`, 'CAPTURED');

    const captureRes = await PaymentApplicationService.capturePayment({
      merchantId: 'merchant_demo_1',
      transactionId: paymentId,
      amountMinor: '100000',
      idempotencyKey: uuidv4()
    });

    expect(captureRes.statusCode).toBe(200);
    expect(captureRes.body.state).toBe('CAPTURED');
  });
});

