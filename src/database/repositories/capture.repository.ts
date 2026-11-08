import pg from 'pg';
import { CaptureOperationStatus } from '../../shared/types/index.js';

export interface CaptureOperationRecord {
  id: string;
  transaction_id: string;
  attempt_id: string;
  operation_key: string;
  amount_minor: string;
  status: CaptureOperationStatus;
  provider_capture_ref: string | null;
  trace_id: string;
  created_at: string;
  updated_at: string;
}

export class CaptureRepository {
  static async create(
    client: pg.PoolClient,
    params: {
      transaction_id: string;
      attempt_id: string;
      operation_key: string;
      amount_minor: string;
      trace_id: string;
    }
  ): Promise<CaptureOperationRecord> {
    const res = await client.query<CaptureOperationRecord>(
      `
      INSERT INTO capture_operations (
        transaction_id, attempt_id, operation_key, amount_minor, status, trace_id
      ) VALUES ($1, $2, $3, $4, 'PENDING', $5)
      RETURNING *
    `,
      [params.transaction_id, params.attempt_id, params.operation_key, params.amount_minor, params.trace_id]
    );
    return res.rows[0];
  }

  static async updateStatus(
    client: pg.PoolClient,
    id: string,
    status: CaptureOperationStatus,
    providerRef?: string
  ): Promise<CaptureOperationRecord> {
    const res = await client.query<CaptureOperationRecord>(
      `
      UPDATE capture_operations
      SET status = $1,
          provider_capture_ref = COALESCE($2, provider_capture_ref),
          updated_at = NOW()
      WHERE id = $3
      RETURNING *
    `,
      [status, providerRef || null, id]
    );
    return res.rows[0];
  }

  static async listByTransactionId(
    client: pg.PoolClient | pg.Pool,
    transactionId: string
  ): Promise<CaptureOperationRecord[]> {
    const res = await client.query<CaptureOperationRecord>(
      `SELECT * FROM capture_operations WHERE transaction_id = $1 ORDER BY created_at ASC`,
      [transactionId]
    );
    return res.rows;
  }
}

