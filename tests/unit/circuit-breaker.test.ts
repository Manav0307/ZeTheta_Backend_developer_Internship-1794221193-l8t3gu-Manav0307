import { describe, it, expect, beforeEach } from 'vitest';
import { CircuitBreakerRepository } from '../../src/database/repositories/circuit-breaker.repository.js';
import { withTransaction, getPool } from '../../src/database/connection.js';
import { v4 as uuidv4 } from 'uuid';

describe('Circuit Breaker Unit Tests', () => {
  beforeEach(async () => {
    await withTransaction(async (client) => {
      await CircuitBreakerRepository.recordSuccess(client, 'razorpay', 'CARD');
    });
  });

  it('transitions from CLOSED to OPEN after 5 consecutive qualified failures', async () => {
    await withTransaction(async (client) => {
      // 1-4 failures: still CLOSED
      for (let i = 1; i <= 4; i++) {
        const b = await CircuitBreakerRepository.recordFailure(client, 'razorpay', 'CARD', 5, 30);
        expect(b.state).toBe('CLOSED');
        expect(b.consecutive_failures).toBe(i);
      }

      // 5th failure: trips to OPEN
      const b5 = await CircuitBreakerRepository.recordFailure(client, 'razorpay', 'CARD', 5, 30);
      expect(b5.state).toBe('OPEN');
      expect(b5.opened_until).not.toBeNull();
    });
  });

  it('resets from HALF_OPEN to CLOSED on successful probe', async () => {
    await withTransaction(async (client) => {
      // Set to HALF_OPEN
      await client.query(
        `UPDATE gateway_circuit_breakers SET state = 'HALF_OPEN' WHERE gateway = 'razorpay' AND payment_method = 'CARD'`
      );

      // Record success
      const reset = await CircuitBreakerRepository.recordSuccess(client, 'razorpay', 'CARD');
      expect(reset.state).toBe('CLOSED');
      expect(reset.consecutive_failures).toBe(0);
      expect(reset.opened_until).toBeNull();
    });
  });

  it('atomic probe lease allows only single probe owner', async () => {
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE gateway_circuit_breakers SET state = 'HALF_OPEN', probe_owner = NULL, probe_lease_until = NULL WHERE gateway = 'razorpay' AND payment_method = 'CARD'`
      );

      const owner1 = uuidv4();
      const owner2 = uuidv4();

      const lease1 = await CircuitBreakerRepository.acquireProbeLease(client, 'razorpay', 'CARD', owner1, 10);
      expect(lease1).toBe(true);

      // Second attempt to acquire concurrent lease must fail
      const lease2 = await CircuitBreakerRepository.acquireProbeLease(client, 'razorpay', 'CARD', owner2, 10);
      expect(lease2).toBe(false);
    });
  });
});

