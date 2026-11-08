import { describe, it, expect, beforeEach } from 'vitest';
import { PaymentApplicationService } from '../../src/modules/payments/payment.service.js';
import { MockGatewayController } from '../../src/gateways/mocks/index.js';
import { PaymentAttemptRepository } from '../../src/database/repositories/attempt.repository.js';
import { getPool } from '../../src/database/connection.js';
import { UnprocessableEntityError } from '../../src/shared/errors/index.js';
import { v4 as uuidv4 } from 'uuid';

describe('Safe Failover & Timeout Integrity Integration Tests', () => {
  beforeEach(() => {
    MockGatewayController.reset();
  });

  it('Hard issuer decline: No automatic failover, terminal decline returned, attempt marked FAILED', async () => {
    // Set both card gateways to hard decline
    MockGatewayController.setBehavior('razorpay', 'hard_decline');
    MockGatewayController.setBehavior('payu', 'hard_decline');
    const orderId = `ord_decline_${Date.now()}`;

    await expect(
      PaymentApplicationService.initiatePayment({
        merchantId: 'merchant_demo_1',
        merchantOrderId: orderId,
        paymentMethod: 'CARD',
        currency: 'INR',
        amountMinor: '45000',
        idempotencyKey: uuidv4()
      })
    ).rejects.toThrow(UnprocessableEntityError);

    const payment = await PaymentApplicationService.getPaymentByMerchantOrderId(orderId, 'merchant_demo_1');
    expect(payment.state).toBe('FAILED');
    expect(payment.attempts.length).toBe(1);
    expect(payment.attempts[0].status).toBe('FAILED');
  });

  it('Definite 5xx error before execution: Triggers safe failover to alternate healthy gateway', async () => {
    // Set razorpay and payu to definite_5xx, stripe is healthy
    MockGatewayController.setBehavior('razorpay', 'definite_5xx');
    MockGatewayController.setBehavior('payu', 'definite_5xx');
    MockGatewayController.setBehavior('stripe', 'success');

    const orderId = `ord_failover_${Date.now()}`;
    const startTime = Date.now();

    const res = await PaymentApplicationService.initiatePayment({
      merchantId: 'merchant_demo_1',
      merchantOrderId: orderId,
      paymentMethod: 'CARD',
      currency: 'INR',
      amountMinor: '50000',
      idempotencyKey: uuidv4()
    });

    const elapsedMs = Date.now() - startTime;

    // Failover should succeed and meet fast recovery target under 2s (2000ms)
    expect(res.statusCode).toBe(201);
    expect(res.body.state).toBe('AUTHORISED');
    expect(res.body.selected_gateway).toBe('stripe');
    expect(elapsedMs).toBeLessThan(2000);

    // Verify both attempts exist with distinct gateway and statuses
    const pool = getPool();
    const attempts = await PaymentAttemptRepository.listByTransactionId(pool, res.body.id);
    expect(attempts.length).toBe(2);
    expect(['razorpay', 'payu']).toContain(attempts[0].gateway);
    expect(attempts[0].status).toBe('FAILED');
    expect(attempts[1].gateway).toBe('stripe');
    expect(attempts[1].status).toBe('AUTHORISED');
  });

  it('Gateway timeout after execution: Marks attempt UNKNOWN and transaction AUTH_TIMEOUT, blocks second charge', async () => {
    // Set primary gateways to timeout_after_execution
    MockGatewayController.setBehavior('razorpay', 'timeout_after_execution');
    MockGatewayController.setBehavior('payu', 'timeout_after_execution');
    const orderId = `ord_timeout_${Date.now()}`;

    const res = await PaymentApplicationService.initiatePayment({
      merchantId: 'merchant_demo_1',
      merchantOrderId: orderId,
      paymentMethod: 'CARD',
      currency: 'INR',
      amountMinor: '60000',
      idempotencyKey: uuidv4()
    });

    expect(res.statusCode).toBe(202);
    expect(res.body.state).toBe('AUTH_TIMEOUT');

    // Crucial check: only ONE attempt made! No competing attempt allowed while outcome is unknown!
    const pool = getPool();
    const attempts = await PaymentAttemptRepository.listByTransactionId(pool, res.body.id);
    expect(attempts.length).toBe(1);
    expect(attempts[0].status).toBe('UNKNOWN');
  });
});

