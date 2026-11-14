import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { getPool } from '../../src/database/connection.js';
import { PaymentApplicationService } from '../../src/modules/payments/payment.service.js';
import { PaymentRetryService, calculateBackoffWithJitter } from '../../src/modules/payments/retry.service.js';
import { CircuitBreakerRepository } from '../../src/database/repositories/circuit-breaker.repository.js';
import { MockGatewayController } from '../../src/gateways/mocks/index.js';

describe('C1: Diwali Sale Double-Charge Prevention & Outbound Retries', () => {
  const app = createApp();
  const pool = getPool();

  beforeEach(async () => {
    MockGatewayController.reset();
    await pool.query(`UPDATE gateway_circuit_breakers SET state = 'CLOSED', consecutive_failures = 0, opened_until = NULL`);
  });

  it('1. Concurrency Safety: sending same idempotency key concurrently produces exactly 1 charge and 0 double-charges', async () => {
    const orderId = `ord_c1_${Date.now()}`;
    const sharedIdempotencyKey = uuidv4();
    const payload = {
      merchant_order_id: orderId,
      amount_minor: '99900',
      currency: 'INR',
      payment_method: 'CARD',
      capture_method: 'AUTOMATIC'
    };

    // Dispatch 2 concurrent requests with identical idempotency key
    const [res1, res2] = await Promise.all([
      request(app)
        .post('/api/v1/payments')
        .set('x-merchant-id', 'merchant_demo_1')
        .set('x-api-key', 'key_test_merchant_demo_1')
        .set('idempotency-key', sharedIdempotencyKey)
        .send(payload),
      request(app)
        .post('/api/v1/payments')
        .set('x-merchant-id', 'merchant_demo_1')
        .set('x-api-key', 'key_test_merchant_demo_1')
        .set('idempotency-key', sharedIdempotencyKey)
        .send(payload)
    ]);

    const statuses = [res1.status, res2.status].sort();
    // One must succeed (201 or 200), and concurrent sibling gets 409 Conflict or deduplicated response
    expect([200, 201]).toContain(statuses[0]);
    expect([200, 201, 409]).toContain(statuses[1]);

    // Verify DB: exactly 1 transaction created for this order
    const txs = await pool.query(
      `SELECT * FROM transactions WHERE merchant_order_id = $1`,
      [orderId]
    );
    expect(txs.rows.length).toBe(1);

    // Verify exactly 1 payment attempt
    const attempts = await pool.query(
      `SELECT * FROM payment_attempts WHERE transaction_id = $1`,
      [txs.rows[0].id]
    );
    expect(attempts.rows.length).toBe(1);
  });

  it('2. Retry Backoff Jitter Bounds: backoff adheres to 1s, 2s, 4s exponential bounds with randomized jitter', () => {
    // Attempt 0: base 1000ms ± 25% => [750ms, 1250ms]
    for (let i = 0; i < 20; i++) {
      const delay0 = calculateBackoffWithJitter(0, 1000, 4000, 0.25);
      expect(delay0).toBeGreaterThanOrEqual(750);
      expect(delay0).toBeLessThanOrEqual(1250);
    }

    // Attempt 1: 2000ms ± 25% => [1500ms, 2500ms]
    for (let i = 0; i < 20; i++) {
      const delay1 = calculateBackoffWithJitter(1, 1000, 4000, 0.25);
      expect(delay1).toBeGreaterThanOrEqual(1500);
      expect(delay1).toBeLessThanOrEqual(2500);
    }

    // Attempt 2: 4000ms (capped) ± 25% => [3000ms, 5000ms]
    for (let i = 0; i < 20; i++) {
      const delay2 = calculateBackoffWithJitter(2, 1000, 4000, 0.25);
      expect(delay2).toBeGreaterThanOrEqual(3000);
      expect(delay2).toBeLessThanOrEqual(5000);
    }
  });

  it('3. Durable Async Retry: worker re-delivery of completed job does not trigger a second financial charge', async () => {
    // Create transaction in CAPTURED state
    const payment = await PaymentApplicationService.initiatePayment({
      merchantId: 'merchant_demo_1',
      merchantOrderId: `ord_c1_retry_${Date.now()}`,
      paymentMethod: 'CARD',
      currency: 'INR',
      amountMinor: '15000',
      captureMode: 'AUTOMATIC',
      idempotencyKey: uuidv4()
    });

    const txId = payment.body.id;

    // Enqueue retry job for an already captured payment
    const jobId = await PaymentRetryService.enqueueRetry({
      transactionId: txId,
      action: 'CAPTURE',
      delayMs: 0
    });

    // Process retry job: must detect terminal state and avoid downstream duplicate charge
    const processed = await PaymentRetryService.processNextRetryJob();
    expect(processed).toBe(true);

    const job = await PaymentRetryService.getJob(jobId);
    expect(job?.status).toBe('COMPLETED');

    // Verify financial consistency: captured_minor is untouched and singular
    const tx = await PaymentApplicationService.getPaymentById(txId, 'merchant_demo_1');
    expect(tx.state).toBe('CAPTURED');
    expect(tx.captured_minor).toBe('15000');
  });

  it('4. Circuit Breaker Protection: 5 consecutive gateway timeouts trip breaker OPEN and routes traffic away', async () => {
    // Record 5 consecutive timeouts on razorpay for CARD
    for (let i = 0; i < 5; i++) {
      await CircuitBreakerRepository.recordFailure(pool, 'razorpay', 'CARD');
    }

    const breaker = await CircuitBreakerRepository.getBreaker(pool, 'razorpay', 'CARD');
    expect(breaker?.state).toBe('OPEN');
    expect(breaker?.consecutive_failures).toBeGreaterThanOrEqual(5);

    // New payment request should route to alternative gateway (payu or stripe), not razorpay
    const payment = await PaymentApplicationService.initiatePayment({
      merchantId: 'merchant_demo_1',
      merchantOrderId: `ord_c1_breaker_${Date.now()}`,
      paymentMethod: 'CARD',
      currency: 'INR',
      amountMinor: '50000',
      captureMode: 'MANUAL',
      idempotencyKey: uuidv4()
    });

    expect(payment.body.selected_gateway).not.toBe('razorpay');
    expect(['payu', 'stripe']).toContain(payment.body.selected_gateway);
  });

  it('5. Ambiguous Timeout Safety: TIMEOUT_UNKNOWN outcome marks AUTH_TIMEOUT and preserves UNKNOWN idempotency without failover charge', async () => {
    MockGatewayController.setBehavior('payu', 'timeout_after_execution');
    MockGatewayController.setBehavior('razorpay', 'timeout_after_execution');
    MockGatewayController.setBehavior('stripe', 'timeout_after_execution');

    const idemKey = uuidv4();
    const orderId = `ord_c1_timeout_${Date.now()}`;

    const res = await request(app)
      .post('/api/v1/payments')
      .set('x-merchant-id', 'merchant_demo_1')
      .set('x-api-key', 'key_test_merchant_demo_1')
      .set('idempotency-key', idemKey)
      .send({
        merchant_order_id: orderId,
        amount_minor: '75000',
        currency: 'INR',
        payment_method: 'CARD',
        capture_method: 'MANUAL'
      });

    // 202 Accepted with uncertain status
    expect(res.status).toBe(202);
    expect(res.body.state).toBe('AUTH_TIMEOUT');

    // Verify idempotency status in DB is UNKNOWN, not SUCCESS or FAILED
    const idemRes = await pool.query(
      `SELECT * FROM idempotency_keys WHERE key = $1`,
      [idemKey]
    );
    expect(idemRes.rows[0].status).toBe('UNKNOWN');

    // Verify exactly 1 payment attempt was recorded (NO blind failover)
    const attempts = await pool.query(
      `SELECT * FROM payment_attempts WHERE transaction_id = $1`,
      [res.body.id]
    );
    expect(attempts.rows.length).toBe(1);
    expect(attempts.rows[0].status).toBe('UNKNOWN');
  });
});
