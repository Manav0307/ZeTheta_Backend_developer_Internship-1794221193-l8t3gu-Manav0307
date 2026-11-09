import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../../src/app.js';
import { MockGatewayController } from '../../../src/gateways/mocks/index.js';
import { getPool } from '../../../src/database/connection.js';
import { v4 as uuidv4 } from 'uuid';

describe('FS-09: Multi-Worker Idempotency Race Under Heavy Concurrency', () => {
  const app = createApp();

  beforeEach(() => {
    MockGatewayController.reset();
  });

  it('coordinates 5 simultaneous competing requests on identical Idempotency-Key: exactly 1 payment created', async () => {
    const idempotencyKey = uuidv4();
    const orderId = `ord_fs09_${Date.now()}`;

    const payload = {
      merchant_order_id: orderId,
      amount_minor: '180000',
      currency: 'INR',
      payment_method: 'CARD',
      capture_method: 'AUTOMATIC'
    };

    // Fire 5 requests concurrently
    const promises = Array.from({ length: 5 }, () =>
      request(app)
        .post('/api/v1/payments')
        .set('x-merchant-id', 'merchant_demo_1')
        .set('x-api-key', 'key_test_merchant_demo_1')
        .set('idempotency-key', idempotencyKey)
        .send(payload)
    );

    const responses = await Promise.all(promises);
    const statusCounts = responses.reduce((acc: Record<number, number>, res) => {
      acc[res.status] = (acc[res.status] || 0) + 1;
      return acc;
    }, {});

    // Must have at least one 201 (the winner), others either 201 (replayed result) or 409 (conflict)
    expect(statusCounts[201]).toBeGreaterThanOrEqual(1);
    const validStatuses = [201, 409];
    responses.forEach((res) => {
      expect(validStatuses).toContain(res.status);
    });

    // Database verification: Exactly 1 transaction created
    const pool = getPool();
    const txRes = await pool.query(
      `SELECT * FROM transactions WHERE merchant_id = 'merchant_demo_1' AND merchant_order_id = $1`,
      [orderId]
    );
    expect(txRes.rows.length).toBe(1);

    // Idempotency table verification: exactly 1 idempotency key row
    const idemRes = await pool.query(
      `SELECT * FROM idempotency_keys WHERE merchant_id = 'merchant_demo_1' AND key = $1`,
      [idempotencyKey]
    );
    expect(idemRes.rows.length).toBe(1);
    expect(idemRes.rows[0].status).toBe('COMPLETED');
  });
});

