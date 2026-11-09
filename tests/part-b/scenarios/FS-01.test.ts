import { describe, it, expect, beforeEach } from 'vitest';
import { PaymentApplicationService } from '../../../src/modules/payments/payment.service.js';
import { MockGatewayController } from '../../../src/gateways/mocks/index.js';
import { getPool } from '../../../src/database/connection.js';
import { v4 as uuidv4 } from 'uuid';

describe('FS-01: Gateway Timeout During Authorization', () => {
  beforeEach(async () => {
    MockGatewayController.reset();
    const pool = getPool();
    await pool.query("UPDATE gateway_circuit_breakers SET state = 'CLOSED', consecutive_failures = 0, opened_until = NULL;");
    await pool.query("DELETE FROM gateway_health_metrics WHERE window_start >= NOW() - INTERVAL '1 hour';");
  });

  it('records circuit breaker failure on primary gateway transient error/timeout and safely completes with alternate gateway', async () => {
    // Primary card gateway (payu) fails with transient 5xx / timeout pre-execution, Razorpay succeeds
    MockGatewayController.setBehavior('payu', 'definite_5xx');
    MockGatewayController.setBehavior('razorpay', 'success');
    MockGatewayController.setBehavior('stripe', 'definite_5xx');

    const orderId = `ord_fs01_${Date.now()}`;
    const startTime = Date.now();

    const result = await PaymentApplicationService.initiatePayment({
      merchantId: 'merchant_demo_1',
      merchantOrderId: orderId,
      paymentMethod: 'CARD',
      currency: 'INR',
      amountMinor: '150000',
      idempotencyKey: uuidv4()
    });

    const elapsedMs = Date.now() - startTime;

    expect(result.statusCode).toBe(201);
    expect(result.body.state).toBe('AUTHORISED');
    expect(result.body.selected_gateway).toBe('razorpay');
    expect(elapsedMs).toBeLessThan(2000); // Latency constraint < 2s

    // Verify circuit breaker logged failures for payu
    const pool = getPool();
    const breakerRes = await pool.query(
      `SELECT * FROM gateway_circuit_breakers WHERE gateway = 'payu' AND payment_method = 'CARD'`
    );
    expect(breakerRes.rows[0].consecutive_failures).toBeGreaterThan(0);

    // Verify two attempts were logged: attempt 1 (failed), attempt 2 (authorised)
    const payment = await PaymentApplicationService.getPaymentById(result.body.id, 'merchant_demo_1');
    expect(payment.attempts.length).toBe(2);
    expect(payment.attempts[0].gateway).toBe('payu');
    expect(payment.attempts[0].status).toBe('FAILED');
    expect(payment.attempts[1].gateway).toBe('razorpay');
    expect(payment.attempts[1].status).toBe('AUTHORISED');
  });

  it('FS-01 Invariant Rule: On unconfirmed downstream socket timeout (TIMEOUT_UNKNOWN), double-charge rule prohibits unverified failover', async () => {
    MockGatewayController.setBehavior('payu', 'timeout_after_execution');

    const orderId = `ord_fs01_safe_${Date.now()}`;
    const res = await PaymentApplicationService.initiatePayment({
      merchantId: 'merchant_demo_1',
      merchantOrderId: orderId,
      paymentMethod: 'CARD',
      currency: 'INR',
      amountMinor: '150000',
      idempotencyKey: uuidv4()
    });

    expect(res.statusCode).toBe(202);
    expect(res.body.state).toBe('AUTH_TIMEOUT');

    const payment = await PaymentApplicationService.getPaymentByMerchantOrderId(orderId, 'merchant_demo_1');
    // Enforces Invariant #2: No failover without verified void/reversal; marked AUTH_TIMEOUT
    expect(payment.state).toBe('AUTH_TIMEOUT');
    expect(payment.attempts.length).toBe(1);
    expect(payment.attempts[0].status).toBe('UNKNOWN');
  });

});

