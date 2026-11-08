import pg from 'pg';
import { PaymentAttemptRecord, AttemptStatus } from '../../shared/types/index.js';

export class PaymentAttemptRepository {
  static async createAttempt(
    client: pg.PoolClient,
    params: {
      transaction_id: string;
      gateway: string;
      attempt_no: number;
      amount_minor: string;
      trace_id: string;
      provider_idempotency_key?: string;
    }
  ): Promise<PaymentAttemptRecord> {
    const res = await client.query<PaymentAttemptRecord>(
      `
      INSERT INTO payment_attempts (
        transaction_id, gateway, attempt_no, amount_minor, trace_id,
        status, provider_idempotency_key, request_dispatched_at
      ) VALUES ($1, $2, $3, $4, $5, 'SENT', $6, NOW())
      RETURNING *
    `,
      [
        params.transaction_id,
        params.gateway,
        params.attempt_no,
        params.amount_minor,
        params.trace_id,
        params.provider_idempotency_key || null
      ]
    );
    return res.rows[0];
  }

  static async updateStatus(
    client: pg.PoolClient,
    params: {
      attempt_id: string;
      status: AttemptStatus;
      provider_payment_ref?: string | null;
      provider_order_ref?: string | null;
      error_class?: string | null;
      error_code?: string | null;
    }
  ): Promise<PaymentAttemptRecord> {
    const res = await client.query<PaymentAttemptRecord>(
      `
      UPDATE payment_attempts
      SET status = $1::VARCHAR,
          provider_payment_ref = COALESCE($2, provider_payment_ref),
          provider_order_ref = COALESCE($3, provider_order_ref),
          error_class = COALESCE($4, error_class),
          error_code = COALESCE($5, error_code),
          resolved_at = CASE WHEN $1::VARCHAR IN ('AUTHORISED', 'CAPTURED', 'FAILED', 'VOIDED') THEN NOW() ELSE resolved_at END,
          updated_at = NOW()
      WHERE id = $6
      RETURNING *
    `,
      [
        params.status,
        params.provider_payment_ref ?? null,
        params.provider_order_ref ?? null,
        params.error_class ?? null,
        params.error_code ?? null,
        params.attempt_id
      ]
    );
    return res.rows[0];
  }

  static async findById(client: pg.PoolClient | pg.Pool, id: string): Promise<PaymentAttemptRecord | null> {
    const res = await client.query<PaymentAttemptRecord>(
      `SELECT * FROM payment_attempts WHERE id = $1`,
      [id]
    );
    return res.rows[0] || null;
  }

  static async findActiveAttempt(
    client: pg.PoolClient | pg.Pool,
    transactionId: string
  ): Promise<PaymentAttemptRecord | null> {
    const res = await client.query<PaymentAttemptRecord>(
      `
      SELECT * FROM payment_attempts
      WHERE transaction_id = $1
        AND status IN ('CREATED', 'SENT', 'UNKNOWN', 'AUTHORISED')
      ORDER BY attempt_no DESC
      LIMIT 1
    `,
      [transactionId]
    );
    return res.rows[0] || null;
  }

  static async findByProviderRef(
    client: pg.PoolClient | pg.Pool,
    gateway: string,
    ref: string
  ): Promise<PaymentAttemptRecord | null> {
    const res = await client.query<PaymentAttemptRecord>(
      `
      SELECT * FROM payment_attempts
      WHERE gateway = $1
        AND (provider_payment_ref = $2 OR provider_order_ref = $2)
      LIMIT 1
    `,
      [gateway, ref]
    );
    return res.rows[0] || null;
  }

  static async listByTransactionId(
    client: pg.PoolClient | pg.Pool,
    transactionId: string
  ): Promise<PaymentAttemptRecord[]> {
    const res = await client.query<PaymentAttemptRecord>(
      `
      SELECT * FROM payment_attempts
      WHERE transaction_id = $1
      ORDER BY attempt_no ASC
    `,
      [transactionId]
    );
    return res.rows;
  }

  static async getNextAttemptNumber(client: pg.PoolClient, transactionId: string): Promise<number> {
    const res = await client.query<{ max_no: number | null }>(
      `SELECT MAX(attempt_no) as max_no FROM payment_attempts WHERE transaction_id = $1`,
      [transactionId]
    );
    return (res.rows[0]?.max_no || 0) + 1;
  }
}
