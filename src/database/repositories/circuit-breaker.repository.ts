import pg from 'pg';
import { CircuitBreakerRecord, CircuitBreakerState, PaymentMethod } from '../../shared/types/index.js';

export class CircuitBreakerRepository {
  static async getBreaker(
    client: pg.PoolClient | pg.Pool,
    gateway: string,
    method: PaymentMethod
  ): Promise<CircuitBreakerRecord | null> {
    const res = await client.query<CircuitBreakerRecord>(
      `SELECT * FROM gateway_circuit_breakers WHERE gateway = $1 AND payment_method = $2`,
      [gateway, method]
    );
    return res.rows[0] || null;
  }

  static async getAllBreakers(client: pg.PoolClient | pg.Pool): Promise<CircuitBreakerRecord[]> {
    const res = await client.query<CircuitBreakerRecord>(
      `SELECT * FROM gateway_circuit_breakers ORDER BY gateway ASC, payment_method ASC`
    );
    return res.rows;
  }

  static async recordFailure(
    client: pg.PoolClient,
    gateway: string,
    method: PaymentMethod,
    threshold: number = 5,
    cooldownSeconds: number = 30
  ): Promise<CircuitBreakerRecord> {
    const res = await client.query<CircuitBreakerRecord>(
      `
      UPDATE gateway_circuit_breakers
      SET consecutive_failures = consecutive_failures + 1,
          state = CASE
            WHEN state = 'HALF_OPEN' THEN 'OPEN'
            WHEN consecutive_failures + 1 >= $3 THEN 'OPEN'
            ELSE state
          END,
          opened_until = CASE
            WHEN state = 'HALF_OPEN' OR consecutive_failures + 1 >= $3
            THEN NOW() + ($4 || ' seconds')::INTERVAL
            ELSE opened_until
          END,
          probe_owner = NULL,
          probe_lease_until = NULL,
          updated_at = NOW()
      WHERE gateway = $1 AND payment_method = $2
      RETURNING *
    `,
      [gateway, method, threshold, cooldownSeconds]
    );

    return res.rows[0];
  }

  static async recordSuccess(
    client: pg.PoolClient,
    gateway: string,
    method: PaymentMethod
  ): Promise<CircuitBreakerRecord> {
    const res = await client.query<CircuitBreakerRecord>(
      `
      UPDATE gateway_circuit_breakers
      SET state = 'CLOSED',
          consecutive_failures = 0,
          opened_until = NULL,
          probe_owner = NULL,
          probe_lease_until = NULL,
          updated_at = NOW()
      WHERE gateway = $1 AND payment_method = $2
      RETURNING *
    `,
      [gateway, method]
    );

    return res.rows[0];
  }

  static async refreshState(
    client: pg.PoolClient | pg.Pool,
    gateway: string,
    method: PaymentMethod
  ): Promise<CircuitBreakerRecord | null> {
    const breaker = await this.getBreaker(client, gateway, method);
    if (!breaker) return null;

    if (breaker.state === 'OPEN' && breaker.opened_until) {
      const openedUntil = new Date(breaker.opened_until).getTime();
      if (Date.now() >= openedUntil) {
        // Cooldown passed, advance to HALF_OPEN
        const res = await client.query<CircuitBreakerRecord>(
          `
          UPDATE gateway_circuit_breakers
          SET state = 'HALF_OPEN',
              updated_at = NOW()
          WHERE gateway = $1 AND payment_method = $2 AND state = 'OPEN'
          RETURNING *
        `,
          [gateway, method]
        );
        return res.rows[0] || breaker;
      }
    }

    return breaker;
  }

  static async acquireProbeLease(
    client: pg.PoolClient,
    gateway: string,
    method: PaymentMethod,
    probeOwner: string,
    leaseSeconds: number = 10
  ): Promise<boolean> {
    const res = await client.query(
      `
      UPDATE gateway_circuit_breakers
      SET probe_owner = $3,
          probe_lease_until = NOW() + ($4 || ' seconds')::INTERVAL,
          updated_at = NOW()
      WHERE gateway = $1 AND payment_method = $2 AND state = 'HALF_OPEN'
        AND (probe_owner IS NULL OR probe_lease_until < NOW())
    `,
      [gateway, method, probeOwner, leaseSeconds]
    );
    return (res.rowCount ?? 0) > 0;
  }
}

