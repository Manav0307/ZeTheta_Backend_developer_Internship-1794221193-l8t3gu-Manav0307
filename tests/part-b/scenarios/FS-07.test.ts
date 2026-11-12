import { describe, it, expect, beforeEach } from 'vitest';
import { PaymentApplicationService } from '../../../src/modules/payments/payment.service.js';
import { IntelligentRouter } from '../../../src/modules/routing/index.js';
import { MockGatewayController } from '../../../src/gateways/mocks/index.js';

import { getPool } from '../../../src/database/connection.js';
import { v4 as uuidv4 } from 'uuid';

describe('FS-07: Cascade Failure Across Gateways & Method-Fit Routing', () => {
  beforeEach(async () => {
    MockGatewayController.reset();
    const pool = getPool();
    await pool.query("UPDATE gateway_circuit_breakers SET state = 'CLOSED', consecutive_failures = 0, opened_until = NULL;");
    await pool.query("DELETE FROM gateway_health_metrics WHERE window_start >= NOW() - INTERVAL '1 hour';");
  });

  it('preserves payment method constraints: UPI is NEVER routed to Card-only Stripe even during cascade failure', async () => {
    const pool = getPool();
    // Razorpay breaker OPEN
    await pool.query(
      `UPDATE gateway_circuit_breakers SET state = 'OPEN', opened_until = NOW() + INTERVAL '10 minutes' WHERE gateway = 'razorpay'`
    );

    // Create a transaction first to satisfy foreign key constraint on gateway_routes
    const traceId = uuidv4();
    const txRes = await pool.query(
      `INSERT INTO transactions (
        merchant_id, merchant_order_id, payment_method, currency, amount_minor, trace_id
      ) VALUES ('merchant_demo_1', $1, 'UPI', 'INR', '100000', $2)
      RETURNING id`,
      [`ord_upi_test_${Date.now()}`, traceId]
    );

    // Request UPI routing
    const client = await pool.connect();
    try {
      const route = await IntelligentRouter.selectRoute(client, {
        transactionId: txRes.rows[0].id,
        paymentMethod: 'UPI',
        currency: 'INR',
        amountMinor: '100000',
        traceId
      });

      // Must be routed to upi or payu (which support UPI). Never Stripe (which does not support UPI)
      expect(route.selectedGateway).not.toBe('stripe');
      expect(['upi', 'payu', 'razorpay']).toContain(route.selectedGateway);
    } finally {
      client.release();
    }
  });


  it('routes card payments away from failed and rate-limited gateways to healthy PayU', async () => {
    // Razorpay is 5xx, Stripe is 429 rate limited, PayU is healthy
    MockGatewayController.setBehavior('razorpay', 'definite_5xx');
    MockGatewayController.setBehavior('stripe', 'rate_limited');
    MockGatewayController.setBehavior('payu', 'success');

    const orderId = `ord_fs07_${Date.now()}`;
    const result = await PaymentApplicationService.initiatePayment({
      merchantId: 'merchant_demo_1',
      merchantOrderId: orderId,
      paymentMethod: 'CARD',
      currency: 'INR',
      amountMinor: '200000',
      idempotencyKey: uuidv4()
    });

    expect(result.statusCode).toBe(201);
    expect(result.body.state).toBe('AUTHORISED');
    expect(result.body.selected_gateway).toBe('payu');
  });
});

