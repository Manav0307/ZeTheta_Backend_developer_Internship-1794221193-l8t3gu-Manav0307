import { describe, it, expect } from 'vitest';
import pg from 'pg';
import { config } from '../../../src/shared/config/index.js';

describe('FS-14: Database Connection Pool Exhaustion & Backpressure', () => {
  it('handles pool saturation gracefully without memory leak or indefinite hanging', async () => {
    // Create a constrained test pool of max 2 connections with 500ms timeout
    const testPool = new pg.Pool({
      connectionString: config.DATABASE_URL,
      max: 2,
      connectionTimeoutMillis: 500
    });

    const acquiredClients: pg.PoolClient[] = [];

    try {
      // 1. Exhaust all 2 available connections
      acquiredClients.push(await testPool.connect());
      acquiredClients.push(await testPool.connect());

      expect(testPool.totalCount).toBe(2);
      expect(testPool.idleCount).toBe(0);

      // 2. Request a 3rd connection: must timeout deterministically instead of hanging indefinitely
      const startTime = Date.now();
      let failed = false;
      try {
        await testPool.connect();
      } catch (err: any) {
        failed = true;
        expect(err.message).toMatch(/timeout/i);
      }
      const elapsed = Date.now() - startTime;

      expect(failed).toBe(true);
      expect(elapsed).toBeLessThan(1500); // Bounded wait, backpressure respected
    } finally {
      // Release held clients
      for (const client of acquiredClients) {
        client.release();
      }
      await testPool.end();
    }
  });
});

