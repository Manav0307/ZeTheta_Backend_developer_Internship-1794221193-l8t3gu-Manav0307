import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../../src/app.js';
import { MockGatewayController } from '../../../src/gateways/mocks/index.js';
import { getPool } from '../../../src/database/connection.js';
import { v4 as uuidv4 } from 'uuid';

describe('FS-03: Double Submit Under High Concurrency', () => {
  const app = createApp();

  beforeEach(() => {
    MockGatewayController.reset();
  });

  it('handles simultaneous double-submit with same Idempotency-Key: exactly 1 charge, 0 duplicate payments', async () => {
    const idempotencyKey = uuidv4();
    const orderId = `ord_fs03_${Date.now()}`;

    const payload = {
      merchant_order_id: orderId,
      amount_minor: '250000',
      currency: 'INR',
      payment_method: 'CARD',
      capture_method: 'AUTOMATIC'
    };

    // Send two requests simultaneously with exact same Idempotency-Key
    const [res1, res2] = await Promise.all([
      request(app)
        .post('/api/v1/payments')
        .set('x-merchant-id', 'merchant_demo_1')
        .set('x-api-key', 'key_test_merchant_demo_1')
        .set('idempotency-key', idempotencyKey)
        .send(payload),
      request(app)
        .post('/api/v1/payments')
        .set('x-merchant-id', 'merchant_demo_1')
        .set('x-api-key', 'key_test_merchant_demo_1')
        .set('idempotency-key', idempotencyKey)
        .send(payload)
    ]);

    const statuses = [res1.status, res2.status].sort();

    // Valid outcomes:
    // Option A: One returns 201 and the concurrent in-flight returns 409 Conflict
    // Option B: One returns 201 and the subsequent returns 201 (replayed identical body)
    expect(
      (statuses[0] === 201 && statuses[1] === 201) ||
      (statuses[0] === 201 && statuses[1] === 409)
    ).toBe(true);

    // Verify exactly 1 transaction was created in database
    const pool = getPool();
    const txRes = await pool.query(
      `SELECT * FROM transactions WHERE merchant_id = 'merchant_demo_1' AND merchant_order_id = $1`,
      [orderId]
    );
    expect(txRes.rows.length).toBe(1);

    // Verify idempotency record exists
    const idemRes = await pool.query(
      `SELECT * FROM idempotency_keys WHERE merchant_id = 'merchant_demo_1' AND key = $1`,
      [idempotencyKey]
    );
    expect(idemRes.rows.length).toBe(1);
    expect(idemRes.rows[0].status).toBe('COMPLETED');
  });
});

