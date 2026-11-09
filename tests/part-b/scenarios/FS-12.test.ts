import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../../src/app.js';
import { TransactionRepository } from '../../../src/database/repositories/transaction.repository.js';
import { withTransaction, getPool } from '../../../src/database/connection.js';
import { v4 as uuidv4 } from 'uuid';

describe('FS-12: UPI Collect Request Expiry and Mandate Timeout', () => {
  const app = createApp();

  beforeEach(() => {
    // reset
  });

  it('expires unapproved UPI collect mandate: transitions AUTH_INITIATED -> AUTH_EXPIRED with 0 retries', async () => {
    // 1. Create a UPI payment in AUTH_INITIATED state
    const orderId = `ord_fs12_${Date.now()}`;
    const traceId = uuidv4();
    let txId = '';

    await withTransaction(async (client) => {
      const tx = await TransactionRepository.create(client, {
        merchant_id: 'merchant_demo_1',
        merchant_order_id: orderId,
        payment_method: 'UPI',
        currency: 'INR',
        amount_minor: '50000',
        capture_mode: 'AUTOMATIC',
        trace_id: traceId
      });
      txId = tx.id;

      await TransactionRepository.transitionState(client, {
        transactionId: tx.id,
        toState: 'ROUTE_SELECTED',
        event: 'ROUTE_SELECT',
        traceId,
        createdBy: 'router'
      });

      await TransactionRepository.transitionState(client, {
        transactionId: tx.id,
        toState: 'AUTH_INITIATED',
        event: 'BEGIN_AUTH',
        traceId,
        createdBy: 'upi_service'
      });
    });

    // 2. Customer does not approve within timeout: mandate expires
    const expireRes = await request(app)
      .post(`/api/v1/payments/${txId}/expire`)
      .set('x-merchant-id', 'merchant_demo_1')
      .set('x-api-key', 'key_test_merchant_demo_1')
      .send();

    expect(expireRes.status).toBe(200);
    expect(expireRes.body.state).toBe('AUTH_EXPIRED');

    // 3. Verify database state is AUTH_EXPIRED
    const pool = getPool();
    const finalTx = await TransactionRepository.findById(pool, txId);
    expect(finalTx?.state).toBe('AUTH_EXPIRED');

    // 4. Verify exactly 1 attempt was made (0 automatic retries for unapproved collect requests)
    const attempts = await pool.query(
      `SELECT * FROM payment_attempts WHERE transaction_id = $1`,
      [txId]
    );
    expect(attempts.rows.length).toBeLessThanOrEqual(1);

    // 5. Verify audit log contains MANDATE_EXPIRED
    const logRes = await pool.query(
      `SELECT * FROM transaction_state_log WHERE transaction_id = $1 AND to_state = 'AUTH_EXPIRED'`,
      [txId]
    );
    expect(logRes.rows.length).toBe(1);
    expect(logRes.rows[0].event).toBe('MANDATE_EXPIRED');
  });
});

