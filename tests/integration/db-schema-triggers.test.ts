import { describe, it, expect } from 'vitest';
import { getPool } from '../../src/database/connection.js';
import { v4 as uuidv4 } from 'uuid';

describe('PostgreSQL Database Schema, Constraints & Triggers Integration Tests', () => {
  it('enforces append-only immutable audit trail trigger on transaction_state_log', async () => {
    const pool = getPool();
    const traceId = uuidv4();
    const orderId = `ord_trg_${Date.now()}_${Math.random()}`;
    const txRes = await pool.query(
      `
      INSERT INTO transactions (
        merchant_id, merchant_order_id, payment_method, currency, amount_minor, trace_id
      ) VALUES ('merch_trigger_test', $1, 'CARD', 'INR', 10000, $2)
      RETURNING id
    `,
      [orderId, traceId]
    );
    const txId = txRes.rows[0].id;

    const logRes = await pool.query(
      `
      INSERT INTO transaction_state_log (
        transaction_id, from_state, to_state, event, trace_id, created_by
      ) VALUES ($1, NULL, 'CREATED', 'INIT', $2, 'test')
      RETURNING id
    `,
      [txId, traceId]
    );
    const logId = logRes.rows[0].id;

    // UPDATE on transaction_state_log must be rejected by trigger
    await expect(
      pool.query(`UPDATE transaction_state_log SET to_state = 'CAPTURED' WHERE id = $1`, [logId])
    ).rejects.toThrow(/append-only/i);

    // DELETE on transaction_state_log must be rejected by trigger
    await expect(
      pool.query(`DELETE FROM transaction_state_log WHERE id = $1`, [logId])
    ).rejects.toThrow(/append-only/i);
  });

  it('enforces unique (merchant_id, merchant_order_id) but allows same order_id for different merchants', async () => {
    const pool = getPool();
    const traceId = uuidv4();
    const sharedOrderId = `order_shared_${Date.now()}_${Math.random()}`;

    await pool.query(
      `
      INSERT INTO transactions (
        merchant_id, merchant_order_id, payment_method, currency, amount_minor, trace_id
      ) VALUES ('merchant_A', $1, 'CARD', 'INR', 10000, $2)
    `,
      [sharedOrderId, traceId]
    );

    // Duplicate for merchant_A must fail
    await expect(
      pool.query(
        `
        INSERT INTO transactions (
          merchant_id, merchant_order_id, payment_method, currency, amount_minor, trace_id
        ) VALUES ('merchant_A', $1, 'CARD', 'INR', 10000, $2)
      `,
        [sharedOrderId, uuidv4()]
      )
    ).rejects.toThrow();

    // Same order_id for merchant_B must SUCCEED (proper merchant scoping)
    const resB = await pool.query(
      `
      INSERT INTO transactions (
        merchant_id, merchant_order_id, payment_method, currency, amount_minor, trace_id
      ) VALUES ('merchant_B', $1, 'CARD', 'INR', 10000, $2)
      RETURNING id
    `,
      [sharedOrderId, uuidv4()]
    );
    expect(resB.rowCount).toBe(1);
  });

  it('enforces positive amount_minor and financial balance check constraints', async () => {
    const pool = getPool();
    const testOrderId = `ord_chk_${Date.now()}`;
    // Amount minor must be > 0
    await expect(
      pool.query(
        `
        INSERT INTO transactions (
          merchant_id, merchant_order_id, payment_method, currency, amount_minor, trace_id
        ) VALUES ('merchant_chk', $1, 'CARD', 'INR', 0, $2)
      `,
        [testOrderId, uuidv4()]
      )
    ).rejects.toThrow();

    // Captured cannot exceed authorized
    await expect(
      pool.query(
        `
        INSERT INTO transactions (
          merchant_id, merchant_order_id, payment_method, currency, amount_minor,
          authorized_minor, captured_minor, trace_id
        ) VALUES ('merchant_chk', $1, 'CARD', 'INR', 10000, 5000, 6000, $2)
      `,
        [testOrderId + '_over', uuidv4()]
      )
    ).rejects.toThrow();
  });

  it('enforces composite foreign key preventing attempt from another transaction', async () => {
    const pool = getPool();
    const o1 = `o1_${Date.now()}_${Math.random()}`;
    const o2 = `o2_${Date.now()}_${Math.random()}`;

    // Create Tx 1
    const tx1 = await pool.query(
      `INSERT INTO transactions (merchant_id, merchant_order_id, payment_method, amount_minor, trace_id)
       VALUES ('m1', $1, 'CARD', 1000, $2) RETURNING id`,
      [o1, uuidv4()]
    );
    // Create Tx 2
    const tx2 = await pool.query(
      `INSERT INTO transactions (merchant_id, merchant_order_id, payment_method, amount_minor, trace_id)
       VALUES ('m1', $2, 'CARD', 1000, $1) RETURNING id`,
      [uuidv4(), o2]
    );

    // Create Attempt for Tx 1
    const att1 = await pool.query(
      `INSERT INTO payment_attempts (transaction_id, gateway, attempt_no, amount_minor, trace_id)
       VALUES ($1, 'razorpay', 1, 1000, $2) RETURNING id`,
      [tx1.rows[0].id, uuidv4()]
    );

    // Try creating capture_operation with Tx 2 but Attempt 1 (composite FK mismatch!)
    await expect(
      pool.query(
        `INSERT INTO capture_operations (transaction_id, attempt_id, operation_key, amount_minor, trace_id)
         VALUES ($1, $2, 'key_1', 1000, $3)`,
        [tx2.rows[0].id, att1.rows[0].id, uuidv4()]
      )
    ).rejects.toThrow();
  });
});
