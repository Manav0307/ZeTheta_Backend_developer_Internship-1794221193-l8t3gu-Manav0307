import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { config } from '../../src/shared/config/index.js';
import { getPool, closePool } from '../../src/database/connection.js';
import { Express } from 'express';
import { v4 as uuidv4 } from 'uuid';

describe('E2E Concurrency and High-Contention Invariants', () => {
  let app: Express;
  const merchantKey = config.MERCHANT_API_KEY;

  beforeAll(async () => {
    app = createApp();
  });

  afterAll(async () => {
    await closePool();
  });

  it('handles 25 concurrent requests with identical Idempotency-Key and body -> exactly 1 payment created, no double charge', async () => {
    const idempotencyKey = `idem_concurrent_${Date.now()}_${Math.random()}`;
    const orderId = `ord_concurrent_${Date.now()}`;
    const payload = {
      merchant_order_id: orderId,
      amount_minor: '25000',
      currency: 'INR',
      payment_method: 'NETBANKING',
      capture_method: 'MANUAL',
    };

    // Dispatch 25 concurrent requests simultaneously
    const promises = Array.from({ length: 25 }, () =>
      request(app)
        .post('/api/v1/payments')
        .set('x-api-key', merchantKey)
        .set('Idempotency-Key', idempotencyKey)
        .send(payload)
    );

    const responses = await Promise.all(promises);

    // Each response must be either 201 (initial creator), 200 (cached replay), or 409 (in-progress lock)
    const validCodes = [200, 201, 409];
    const statusCodes = responses.map((r) => r.status);
    expect(statusCodes.every((s) => validCodes.includes(s))).toBe(true);

    // Filter out successfully resolved responses
    const successfulResponses = responses.filter((r) => r.status === 200 || r.status === 201);
    expect(successfulResponses.length).toBeGreaterThanOrEqual(1);

    // All successful responses must return the EXACT same transaction id
    const transactionIds = successfulResponses.map((r) => r.body.id);
    const uniqueTxIds = Array.from(new Set(transactionIds));
    expect(uniqueTxIds.length).toBe(1);

    // Any in-flight 409 responses must return IDEMPOTENCY_IN_PROGRESS
    const inProgressResponses = responses.filter((r) => r.status === 409);
    for (const res of inProgressResponses) {
      expect(res.body.error.code).toBe('IDEMPOTENCY_IN_PROGRESS');
    }

    // Retrying with the same idempotency key now that it is completed must return the cached result (201)
    const replayRes = await request(app)
      .post('/api/v1/payments')
      .set('x-api-key', merchantKey)
      .set('Idempotency-Key', idempotencyKey)
      .send(payload);

    expect([200, 201]).toContain(replayRes.status);
    expect(replayRes.body.id).toBe(uniqueTxIds[0]);

    // Verify in database: exactly ONE transaction and ONE idempotency key row exist
    const pool = getPool();
    const txCountRes = await pool.query(
      'SELECT count(*) as count FROM transactions WHERE merchant_order_id = $1',
      [orderId]
    );
    expect(Number(txCountRes.rows[0].count)).toBe(1);

    const idemRes = await pool.query(
      'SELECT status FROM idempotency_keys WHERE key = $1',
      [idempotencyKey]
    );
    expect(idemRes.rows.length).toBe(1);
    expect(idemRes.rows[0].status).toBe('COMPLETED');
  });

  it('rejects an identical Idempotency-Key when the request payload differs (hash mismatch -> 409 IDEMPOTENCY_KEY_REUSED)', async () => {
    const idempotencyKey = `idem_tamper_${Date.now()}_${Math.random()}`;
    const orderId1 = `ord_tamper_1_${Date.now()}`;
    const orderId2 = `ord_tamper_2_${Date.now()}`;

    // First request
    const firstRes = await request(app)
      .post('/api/v1/payments')
      .set('x-api-key', merchantKey)
      .set('Idempotency-Key', idempotencyKey)
      .send({
        merchant_order_id: orderId1,
        amount_minor: '10000',
        currency: 'INR',
        payment_method: 'CARD',
        capture_method: 'MANUAL',
      });

    expect(firstRes.status).toBe(201);

    // Second request with SAME idempotency key but altered amount
    const secondRes = await request(app)
      .post('/api/v1/payments')
      .set('x-api-key', merchantKey)
      .set('Idempotency-Key', idempotencyKey)
      .send({
        merchant_order_id: orderId2,
        amount_minor: '99999', // Altered payload
        currency: 'INR',
        payment_method: 'CARD',
        capture_method: 'MANUAL',
      });

    expect(secondRes.status).toBe(409);
    expect(secondRes.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('prevents double-capture race condition on concurrent captures exceeding authorized amount', async () => {
    // 1. Create an AUTHORISED transaction for 10000 minor units
    const orderId = `ord_race_capture_${Date.now()}`;
    const initRes = await request(app)
      .post('/api/v1/payments')
      .set('x-api-key', merchantKey)
      .set('Idempotency-Key', uuidv4())
      .send({
        merchant_order_id: orderId,
        amount_minor: '10000',
        currency: 'INR',
        payment_method: 'CARD',
        capture_method: 'MANUAL',
      });

    expect(initRes.status).toBe(201);
    const txId = initRes.body.id;
    expect(initRes.body.state).toBe('AUTHORISED');

    // 2. Dispatch two simultaneous capture requests for 7000 minor units each
    // Total requested = 14000, which exceeds 10000
    const [cap1, cap2] = await Promise.all([
      request(app)
        .post(`/api/v1/payments/${txId}/capture`)
        .set('x-api-key', merchantKey)
        .set('Idempotency-Key', uuidv4())
        .send({ amount_minor: '7000' }),
      request(app)
        .post(`/api/v1/payments/${txId}/capture`)
        .set('x-api-key', merchantKey)
        .set('Idempotency-Key', uuidv4())
        .send({ amount_minor: '7000' }),
    ]);

    // Exactly one should succeed (200) and the other should fail (422 CAPTURE_AMOUNT_EXCEEDED)
    const successCount = (cap1.status === 200 ? 1 : 0) + (cap2.status === 200 ? 1 : 0);
    const failCount = (cap1.status === 422 ? 1 : 0) + (cap2.status === 422 ? 1 : 0);

    expect(successCount).toBe(1);
    expect(failCount).toBe(1);

    // 3. Verify in database that total captured amount is exactly 7000, never 14000
    const pool = getPool();
    const txCheck = await pool.query(
      'SELECT captured_minor, state FROM transactions WHERE id = $1',
      [txId]
    );
    expect(Number(txCheck.rows[0].captured_minor)).toBe(7000);
    expect(txCheck.rows[0].state).toBe('PARTIALLY_CAPTURED');
  });
});
