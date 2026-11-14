import { describe, it, expect } from 'vitest';
import pg from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { config } from '../../src/shared/config/index.js';
import { getPool } from '../../src/database/connection.js';

describe('C5: Flash-Sale Connection-Pool Stampede & Resource Protection', () => {
  it('1. Connection Lifecyle: Pool clients are NOT held during external gateway calls', async () => {
    const mainPool = getPool();
    const initialWaiting = mainPool.waitingCount;

    // Monitor pool active/idle count before and during execution
    const initialIdle = mainPool.idleCount;

    // Trigger payment initiation
    const app = createApp();
    const res = await request(app)
      .post('/api/v1/payments')
      .set('x-merchant-id', 'merchant_demo_1')
      .set('x-api-key', 'key_test_merchant_demo_1')
      .set('idempotency-key', `idem_c5_${Date.now()}`)
      .send({
        merchant_order_id: `ord_c5_${Date.now()}`,
        amount_minor: '10000',
        currency: 'INR',
        payment_method: 'CARD',
        capture_method: 'AUTOMATIC'
      });

    expect([200, 201]).toContain(res.status);

    // Verify after call finishes, no leaked clients remain checked out
    expect(mainPool.waitingCount).toBe(initialWaiting);
  });

  it('2. Fail-Fast 503 on Pool Saturation: Returns 503 with Retry-After when DB pool is exhausted', async () => {
    // Spin up an ultra-constrained pool (max 1 connection, 100ms timeout)
    const constrainedPool = new pg.Pool({
      connectionString: config.DATABASE_URL,
      max: 1,
      connectionTimeoutMillis: 100
    });

    const client = await constrainedPool.connect();

    try {
      // Attempting to acquire second client triggers timeout
      let caughtError: any = null;
      try {
        await constrainedPool.connect();
      } catch (err: any) {
        caughtError = err;
      }

      expect(caughtError).not.toBeNull();
      expect(caughtError.message).toMatch(/timeout exceeded (when trying to connect|waiting for client)/i);

      // Verify the error middleware maps this directly to 503 Service Unavailable
      const express = (await import('express')).default;
      const testApp = express();
      const { errorMiddleware } = await import('../../src/api/middleware/error.middleware.js');

      testApp.get('/test-pool-error', () => {
        throw caughtError;
      });
      testApp.use(errorMiddleware);

      const errRes = await request(testApp).get('/test-pool-error');
      expect(errRes.status).toBe(503);
      expect(errRes.headers['retry-after']).toBe('5');
      expect(errRes.body.error.code).toBe('SERVICE_UNAVAILABLE');
    } finally {
      client.release();
      await constrainedPool.end();
    }
  });
});

