import pg from 'pg';
import {
  TransactionRecord,
  TransactionState,
  PaymentMethod,
  CaptureMode,
  TransactionStateLogRecord
} from '../../shared/types/index.js';
import {
  isValidTransition,
  getAllowedTransitions,
  assertValidTransition
} from '../../modules/state-machine/index.js';
import {
  NotFoundError,
  UnprocessableEntityError,
  InvalidStateTransitionException
} from '../../shared/errors/index.js';
import { getPool } from '../connection.js';


export class TransactionRepository {
  static async create(
    client: pg.PoolClient,
    params: {
      merchant_id: string;
      merchant_order_id: string;
      payment_method: PaymentMethod;
      currency: string;
      amount_minor: string;
      capture_mode: CaptureMode;
      trace_id: string;
      metadata?: Record<string, any>;
      created_by?: string;
    }
  ): Promise<TransactionRecord> {
    const res = await client.query<TransactionRecord>(
      `
      INSERT INTO transactions (
        merchant_id, merchant_order_id, payment_method, currency, amount_minor,
        capture_mode, state, trace_id, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, 'CREATED', $7, $8)
      RETURNING *
    `,
      [
        params.merchant_id,
        params.merchant_order_id,
        params.payment_method,
        params.currency || 'INR',
        params.amount_minor,
        params.capture_mode || 'MANUAL',
        params.trace_id,
        JSON.stringify(params.metadata || {})
      ]
    );

    const transaction = res.rows[0];

    // Initial audit log for CREATED state
    await client.query(
      `
      INSERT INTO transaction_state_log (
        transaction_id, from_state, to_state, event, trace_id, created_by, metadata
      ) VALUES ($1, NULL, 'CREATED', 'TRANSACTION_INITIATED', $2, $3, $4)
    `,
      [
        transaction.id,
        params.trace_id,
        params.created_by || 'api',
        JSON.stringify(params.metadata || {})
      ]
    );

    return transaction;
  }

  static async findById(client: pg.PoolClient | pg.Pool, id: string): Promise<TransactionRecord | null> {
    const res = await client.query<TransactionRecord>(
      `SELECT * FROM transactions WHERE id = $1`,
      [id]
    );
    return res.rows[0] || null;
  }

  static async findByMerchantOrderId(
    client: pg.PoolClient | pg.Pool,
    merchantId: string,
    orderId: string
  ): Promise<TransactionRecord | null> {
    const res = await client.query<TransactionRecord>(
      `SELECT * FROM transactions WHERE merchant_id = $1 AND merchant_order_id = $2`,
      [merchantId, orderId]
    );
    return res.rows[0] || null;
  }

  static async lockForUpdate(client: pg.PoolClient, id: string): Promise<TransactionRecord> {
    const res = await client.query<TransactionRecord>(
      `SELECT * FROM transactions WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (!res.rows[0]) {
      throw new NotFoundError(`Transaction ${id} not found`, 'TRANSACTION_NOT_FOUND');
    }
    return res.rows[0];
  }

  static async transitionState(
    client: pg.PoolClient,
    params: {
      transactionId: string;
      toState: TransactionState;
      event: string;
      traceId: string;
      createdBy: string;
      attemptId?: string;
      gatewayReference?: string;
      gatewayResponse?: Record<string, any>;
      metadata?: Record<string, any>;
      authorized_minor?: string;
      captured_minor?: string;
      refunded_minor?: string;
      reserved_refund_minor?: string;
      lastErrorCode?: string;
    }
  ): Promise<TransactionRecord> {
    // 1. Lock parent row
    const current = await this.lockForUpdate(client, params.transactionId);

    // 2. Early webhook / out-of-order race check (Part B FS-06)
    if (current.state === 'CAPTURED' && (params.toState === 'AUTHORISED' || params.toState === 'CAPTURED')) {
      await client.query(
        `
        INSERT INTO transaction_state_log (
          transaction_id, attempt_id, from_state, to_state, event,
          gateway_reference, gateway_response, metadata, trace_id, created_by
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `,
        [
          params.transactionId,
          params.attemptId || null,
          current.state,
          current.state,
          'OUT_OF_ORDER_RESOLUTION',
          params.gatewayReference || null,
          JSON.stringify(params.gatewayResponse || {}),
          JSON.stringify({ ...params.metadata, note: 'Out-of-order race resolved; already CAPTURED' }),
          params.traceId,
          params.createdBy
        ]
      );
      return current;
    }

    // 3. Validate transition legality (Part B FS-15)
    if (!isValidTransition(current.state, params.toState)) {
      const allowed = getAllowedTransitions(current.state);
      throw new InvalidStateTransitionException(
        current.state,
        params.toState,
        allowed,
        { event: params.event, ...params.metadata }
      );
    }



    // 3. Update transaction row
    const res = await client.query<TransactionRecord>(
      `
      UPDATE transactions
      SET state = $1,
          authorized_minor = COALESCE($2, authorized_minor),
          captured_minor = COALESCE($3, captured_minor),
          refunded_minor = COALESCE($4, refunded_minor),
          reserved_refund_minor = COALESCE($5, reserved_refund_minor),
          last_error_code = COALESCE($6, last_error_code),
          version = version + 1,
          updated_at = NOW()
      WHERE id = $7
      RETURNING *
    `,
      [
        params.toState,
        params.authorized_minor ?? null,
        params.captured_minor ?? null,
        params.refunded_minor ?? null,
        params.reserved_refund_minor ?? null,
        params.lastErrorCode ?? null,
        params.transactionId
      ]
    );

    const updated = res.rows[0];

    // 4. Atomically insert state log
    await client.query(
      `
      INSERT INTO transaction_state_log (
        transaction_id, attempt_id, from_state, to_state, event,
        gateway_reference, gateway_response, metadata, trace_id, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `,
      [
        params.transactionId,
        params.attemptId || null,
        current.state,
        params.toState,
        params.event,
        params.gatewayReference || null,
        JSON.stringify(params.gatewayResponse || {}),
        JSON.stringify(params.metadata || {}),
        params.traceId,
        params.createdBy
      ]
    );

    return updated;
  }

  static async getTimeline(
    client: pg.PoolClient | pg.Pool,
    transactionId: string
  ): Promise<TransactionStateLogRecord[]> {
    const res = await client.query<TransactionStateLogRecord>(
      `
      SELECT * FROM transaction_state_log
      WHERE transaction_id = $1
      ORDER BY created_at ASC, id ASC
    `,
      [transactionId]
    );
    return res.rows;
  }
}

