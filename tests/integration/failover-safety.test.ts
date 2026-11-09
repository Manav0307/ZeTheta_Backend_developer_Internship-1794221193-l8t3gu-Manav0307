import { describe, it, expect, beforeEach } from 'vitest';
import { PaymentApplicationService } from '../../src/modules/payments/payment.service.js';
import { MockGatewayController } from '../../src/gateways/mocks/index.js';
import { PaymentAttemptRepository } from '../../src/database/repositories/attempt.repository.js';
import { getPool } from '../../src/database/connection.js';
import { UnprocessableEntityError } from '../../src/shared/errors/index.js';
import { v4 as uuidv4 } from 'uuid';

describe('Safe Failover & Timeout Integrity Integration Tests', () => {
  beforeEach(async () => {
    MockGatewayController.reset();
    const pool = getPool();
    await pool.query("UPDATE gateway_circuit_breakers SET state = 'CLOSED', consecutive_failures = 0, opened_until = NULL;");
    await pool.query("DELETE FROM gateway_health_metrics WHERE window_start >= NOW() - INTERVAL '1 hour';");
  });

  it('Hard issuer decline: No automatic failover, terminal decline returned, attempt marked FAILED', async () => {
    // Set all card gateways to hard decline
    MockGatewayController.setBehavior('razorpay', 'hard_decline');
    MockGatewayController.setBehavior('payu', 'hard_decline');
    MockGatewayController.setBehavior('stripe', 'hard_decline');
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
    // Primary card gateway (payu) fails with 5xx, alternate (razorpay) is healthy
    MockGatewayController.setBehavior('payu', 'definite_5xx');
    MockGatewayController.setBehavior('razorpay', 'success');
    MockGatewayController.setBehavior('stripe', 'definite_5xx');

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
    expect(res.body.selected_gateway).toBe('razorpay');
    expect(elapsedMs).toBeLessThan(2000);

    // Verify both attempts exist with distinct gateway and statuses
    const pool = getPool();
    const attempts = await PaymentAttemptRepository.listByTransactionId(pool, res.body.id);
    expect(attempts.length).toBe(2);
    expect(attempts[0].gateway).toBe('payu');
    expect(attempts[0].status).toBe('FAILED');
    expect(attempts[1].gateway).toBe('razorpay');
    expect(attempts[1].status).toBe('AUTHORISED');
  });

  it('Gateway timeout after execution: Marks attempt UNKNOWN and transaction AUTH_TIMEOUT, blocks second charge', async () => {
    // Set card gateways to timeout_after_execution
    MockGatewayController.setBehavior('razorpay', 'timeout_after_execution');
    MockGatewayController.setBehavior('payu', 'timeout_after_execution');
    MockGatewayController.setBehavior('stripe', 'timeout_after_execution');
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

