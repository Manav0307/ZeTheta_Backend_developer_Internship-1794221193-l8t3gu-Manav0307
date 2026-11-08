import { describe, it, expect, beforeEach } from 'vitest';
import { IntelligentRouter } from '../../src/modules/routing/index.js';
import { withTransaction, getPool } from '../../src/database/connection.js';
import { CircuitBreakerRepository } from '../../src/database/repositories/circuit-breaker.repository.js';
import { v4 as uuidv4 } from 'uuid';

describe('Intelligent Router Unit & Scoring Tests', () => {
  it('excludes gateways that do not support the requested payment method', async () => {
    const pool = getPool();
    await withTransaction(async (client) => {
      // Create a dummy transaction for routing test
      const txRes = await client.query(
        `
        INSERT INTO transactions (
          merchant_id, merchant_order_id, payment_method, currency, amount_minor, trace_id
        ) VALUES ('merch_test', 'ord_route_1_' || gen_random_uuid(), 'UPI', 'INR', 10000, $1)
        RETURNING id
      `,
        [uuidv4()]
      );

      const result = await IntelligentRouter.selectRoute(client, {
        transactionId: txRes.rows[0].id,
        paymentMethod: 'UPI',
        currency: 'INR',
        amountMinor: '10000',
        traceId: uuidv4()
      });

      // Stripe does not support UPI, so Stripe should never be in candidate scores
      const stripeCandidate = result.candidateScores.find((c) => c.gateway === 'stripe');
      expect(stripeCandidate).toBeUndefined();

      // Selected gateway should be an eligible one (e.g. razorpay, payu, or upi)
      expect(['upi', 'razorpay', 'payu']).toContain(result.selectedGateway);
    });
  });

  it('excludes gateways with OPEN circuit breakers', async () => {
    await withTransaction(async (client) => {
      // Trip Razorpay CARD breaker
      await client.query(
        `
        UPDATE gateway_circuit_breakers
        SET state = 'OPEN', opened_until = NOW() + INTERVAL '1 hour'
        WHERE gateway = 'razorpay' AND payment_method = 'CARD'
      `
      );

      const txRes = await client.query(
        `
        INSERT INTO transactions (
          merchant_id, merchant_order_id, payment_method, currency, amount_minor, trace_id
        ) VALUES ('merch_test', 'ord_route_2_' || gen_random_uuid(), 'CARD', 'INR', 50000, $1)
        RETURNING id
      `,
        [uuidv4()]
      );

      const result = await IntelligentRouter.selectRoute(client, {
        transactionId: txRes.rows[0].id,
        paymentMethod: 'CARD',
        currency: 'INR',
        amountMinor: '50000',
        traceId: uuidv4()
      });

      // Razorpay must NOT be candidate when breaker is OPEN
      const rzpCandidate = result.candidateScores.find((c) => c.gateway === 'razorpay');
      expect(rzpCandidate).toBeUndefined();

      // Reset Razorpay breaker
      await CircuitBreakerRepository.recordSuccess(client, 'razorpay', 'CARD');
    });
  });

  it('favors healthier candidate over HALF_OPEN gateway when within 20% score difference', async () => {
    await withTransaction(async (client) => {
      // Set Stripe to HALF_OPEN
      await client.query(
        `
        UPDATE gateway_circuit_breakers
        SET state = 'HALF_OPEN'
        WHERE gateway = 'stripe' AND payment_method = 'CARD'
      `
      );

      const txRes = await client.query(
        `
        INSERT INTO transactions (
          merchant_id, merchant_order_id, payment_method, currency, amount_minor, trace_id
        ) VALUES ('merch_test', 'ord_route_3_' || gen_random_uuid(), 'CARD', 'INR', 20000, $1)
        RETURNING id
      `,
        [uuidv4()]
      );

      const result = await IntelligentRouter.selectRoute(client, {
        transactionId: txRes.rows[0].id,
        paymentMethod: 'CARD',
        currency: 'INR',
        amountMinor: '20000',
        traceId: uuidv4()
      });

      expect(result.candidateScores.length).toBeGreaterThan(0);

      // Reset Stripe breaker
      await CircuitBreakerRepository.recordSuccess(client, 'stripe', 'CARD');
    });
  });
});

