import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../../src/app.js';
import { TransactionRepository } from '../../../src/database/repositories/transaction.repository.js';
import { withTransaction, getPool } from '../../../src/database/connection.js';
import { v4 as uuidv4 } from 'uuid';

describe('FS-15: State Machine Illegal Transition Protection & Rejection Audit', () => {
  const app = createApp();

  beforeEach(() => {
    // reset
  });

  it('rejects illegal transition CREATED -> REFUNDED with 422, allowed transitions, and REJECTED_TRANSITION audit log', async () => {
    // 1. Create a payment in CREATED state
    const orderId = `ord_fs15_${Date.now()}`;
    const traceId = uuidv4();
    let txId = '';

    await withTransaction(async (client) => {
      const tx = await TransactionRepository.create(client, {
        merchant_id: 'merchant_demo_1',
        merchant_order_id: orderId,
        payment_method: 'CARD',
        currency: 'INR',
        amount_minor: '100000',
        capture_mode: 'AUTOMATIC',
        trace_id: traceId
      });
      txId = tx.id;
    });

    // 2. Attempt illegal transition CREATED -> REFUNDED via API
    const res = await request(app)
      .post(`/api/v1/transactions/${txId}/transition`)
      .set('x-merchant-id', 'merchant_demo_1')
      .set('x-api-key', 'key_test_merchant_demo_1')
      .send({ targetState: 'REFUNDED' });

    // Expect HTTP 422
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('INVALID_STATE_TRANSITION');
    expect(res.body.current).toBe('CREATED');
    expect(res.body.requested).toBe('REFUNDED');
    expect(res.body.allowedTransitions).toContain('ROUTE_SELECTED');
    expect(res.body.allowedTransitions).toContain('ABANDONED');

    // 3. Verify transaction state remains CREATED (no corruption)
    const pool = getPool();
    const finalTx = await TransactionRepository.findById(pool, txId);
    expect(finalTx?.state).toBe('CREATED');

    // 4. Verify audit log recorded REJECTED_TRANSITION event
    const logRes = await pool.query(
      `SELECT * FROM transaction_state_log WHERE transaction_id = $1 AND event = 'REJECTED_TRANSITION'`,
      [txId]
    );

    expect(logRes.rows.length).toBe(1);
    const auditRecord = logRes.rows[0];
    expect(auditRecord.from_state).toBe('CREATED');
    expect(auditRecord.to_state).toBe('CREATED');
    expect(auditRecord.metadata.attempted_to_state).toBe('REFUNDED');
    expect(auditRecord.metadata.allowed_transitions).toEqual(
      expect.arrayContaining(['ROUTE_SELECTED', 'ABANDONED'])
    );
  });
});

