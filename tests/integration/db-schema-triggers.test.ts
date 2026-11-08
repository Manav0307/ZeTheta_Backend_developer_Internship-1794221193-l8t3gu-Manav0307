import { describe, it, expect } from 'vitest';
import { withTransaction } from '../../src/database/connection.js';
import { v4 as uuidv4 } from 'uuid';

describe('PostgreSQL Database Schema, Constraints & Triggers Integration Tests', () => {
  it('enforces append-only immutable audit trail trigger on transaction_state_log', async () => {
    await withTransaction(async (client) => {
      const traceId = uuidv4();
      const txRes = await client.query(
        `
        INSERT INTO transactions (
          merchant_id, merchant_order_id, payment_method, currency, amount_minor, trace_id
        ) VALUES ('merch_trigger_test', 'ord_trg_1', 'CARD', 'INR', 10000, $1)
        RETURNING id
      `,
        [traceId]
      );
      const txId = txRes.rows[0].id;

      const logRes = await client.query(
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
        client.query(`UPDATE transaction_state_log SET to_state = 'CAPTURED' WHERE id = $1`, [logId])
      ).rejects.toThrow(/append-only/i);

      // DELETE on transaction_state_log must be rejected by trigger
      await expect(
        client.query(`DELETE FROM transaction_state_log WHERE id = $1`, [logId])
      ).rejects.toThrow(/append-only/i);
    });
  });

  it('enforces unique (merchant_id, merchant_order_id) but allows same order_id for different merchants', async () => {
    await withTransaction(async (client) => {
      const traceId = uuidv4();
      await client.query(
        `
        INSERT INTO transactions (
          merchant_id, merchant_order_id, payment_method, currency, amount_minor, trace_id
        ) VALUES ('merchant_A', 'order_shared_99', 'CARD', 'INR', 10000, $1)
      `,
        [traceId]
      );

      // Duplicate for merchant_A must fail
      await expect(
        client.query(
          `
          INSERT INTO transactions (
            merchant_id, merchant_order_id, payment_method, currency, amount_minor, trace_id
          ) VALUES ('merchant_A', 'order_shared_99', 'CARD', 'INR', 10000, $1)
        `,
          [uuidv4()]
        )
      ).rejects.toThrow();

      // Same order_id for merchant_B must SUCCEED (proper merchant scoping)
      const resB = await client.query(
        `
        INSERT INTO transactions (
          merchant_id, merchant_order_id, payment_method, currency, amount_minor, trace_id
        ) VALUES ('merchant_B', 'order_shared_99', 'CARD', 'INR', 10000, $1)
        RETURNING id
      `,
        [uuidv4()]
      );
      expect(resB.rowCount).toBe(1);
    });
  });

  it('enforces positive amount_minor and financial balance check constraints', async () => {
    await withTransaction(async (client) => {
      // Amount minor must be > 0
      await expect(
        client.query(
          `
          INSERT INTO transactions (
            merchant_id, merchant_order_id, payment_method, currency, amount_minor, trace_id
          ) VALUES ('merchant_chk', 'ord_chk_zero', 'CARD', 'INR', 0, $1)
        `,
          [uuidv4()]
        )
      ).rejects.toThrow();

      // Captured cannot exceed authorized
      await expect(
        client.query(
          `
          INSERT INTO transactions (
            merchant_id, merchant_order_id, payment_method, currency, amount_minor,
            authorized_minor, captured_minor, trace_id
          ) VALUES ('merchant_chk', 'ord_chk_overcap', 'CARD', 'INR', 10000, 5000, 6000, $1)
        `,
          [uuidv4()]
        )
      ).rejects.toThrow();
    });
  });

  it('enforces composite foreign key preventing attempt from another transaction', async () => {
    await withTransaction(async (client) => {
      // Create Tx 1
      const tx1 = await client.query(
        `INSERT INTO transactions (merchant_id, merchant_order_id, payment_method, amount_minor, trace_id)
         VALUES ('m1', 'o1', 'CARD', 1000, $1) RETURNING id`,
        [uuidv4()]
      );
      // Create Tx 2
      const tx2 = await client.query(
        `INSERT INTO transactions (merchant_id, merchant_order_id, payment_method, amount_minor, trace_id)
         VALUES ('m1', 'o2', 'CARD', 1000, $1) RETURNING id`,
        [uuidv4()]
      );

      // Create Attempt for Tx 1
      const att1 = await client.query(
        `INSERT INTO payment_attempts (transaction_id, gateway, attempt_no, amount_minor, trace_id)
         VALUES ($1, 'razorpay', 1, 1000, $2) RETURNING id`,
        [tx1.rows[0].id, uuidv4()]
      );

      // Try creating capture_operation with Tx 2 but Attempt 1 (composite FK mismatch!)
      await expect(
        client.query(
          `INSERT INTO capture_operations (transaction_id, attempt_id, operation_key, amount_minor, trace_id)
           VALUES ($1, $2, 'key_1', 1000, $3)`,
          [tx2.rows[0].id, att1.rows[0].id, uuidv4()]
        )
      ).rejects.toThrow();
    });
  });
});

