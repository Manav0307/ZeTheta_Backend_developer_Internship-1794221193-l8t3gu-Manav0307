import pg from 'pg';
import { RefundStatus } from '../../shared/types/index.js';

export interface RefundRecord {
  id: string;
  transaction_id: string;
  attempt_id: string;
  operation_key: string;
  amount_minor: string;
  currency: string;
  status: RefundStatus;
  gateway_refund_id: string | null;
  reason: string | null;
  trace_id: string;
  created_at: string;
  updated_at: string;
}

export class RefundRepository {
  static async create(
    client: pg.PoolClient,
    params: {
      transaction_id: string;
      attempt_id: string;
      operation_key: string;
      amount_minor: string;
      currency?: string;
      reason?: string;
      trace_id: string;
    }
  ): Promise<RefundRecord> {
    const res = await client.query<RefundRecord>(
      `
      INSERT INTO refunds (
        transaction_id, attempt_id, operation_key, amount_minor, currency,
        reason, status, trace_id
      ) VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', $7)
      RETURNING *
    `,
      [
        params.transaction_id,
        params.attempt_id,
        params.operation_key,
        params.amount_minor,
        params.currency || 'INR',
        params.reason || null,
        params.trace_id
      ]
    );
    return res.rows[0];
  }

  static async updateStatus(
    client: pg.PoolClient,
    id: string,
    status: RefundStatus,
    gatewayRefundId?: string
  ): Promise<RefundRecord> {
    const res = await client.query<RefundRecord>(
      `
      UPDATE refunds
      SET status = $1,
          gateway_refund_id = COALESCE($2, gateway_refund_id),
          updated_at = NOW()
      WHERE id = $3
      RETURNING *
    `,
      [status, gatewayRefundId || null, id]
    );
    return res.rows[0];
  }

  static async listByTransactionId(
    client: pg.PoolClient | pg.Pool,
    transactionId: string
  ): Promise<RefundRecord[]> {
    const res = await client.query<RefundRecord>(
      `SELECT * FROM refunds WHERE transaction_id = $1 ORDER BY created_at ASC`,
      [transactionId]
    );
    return res.rows;
  }
}

