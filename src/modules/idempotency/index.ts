import crypto from 'crypto';
import pg from 'pg';
import { IdempotencyOperation, IdempotencyKeyRecord } from '../../shared/types/index.js';
import { ConflictError } from '../../shared/errors/index.js';
import { withTransaction } from '../../database/connection.js';

export function canonicalizePayload(payload: any): string {
  if (payload === null || payload === undefined) {
    return '';
  }
  if (typeof payload !== 'object') {
    return String(payload);
  }
  if (Array.isArray(payload)) {
    return JSON.stringify(
      payload.map((item) =>
        item === null || item === undefined
          ? null
          : typeof item === 'object'
          ? JSON.parse(canonicalizePayload(item))
          : item
      )
    );
  }
  const sortedKeys = Object.keys(payload).sort();
  const sortedObj: Record<string, any> = {};
  for (const k of sortedKeys) {
    const val = payload[k];
    if (val === null || val === undefined) {
      sortedObj[k] = null;
    } else if (typeof val === 'object') {
      sortedObj[k] = JSON.parse(canonicalizePayload(val));
    } else {
      sortedObj[k] = val;
    }
  }
  return JSON.stringify(sortedObj);
}

export function hashPayload(payload: any): string {
  const canonical = canonicalizePayload(payload);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

export interface ClaimResult {
  isCached: boolean;
  statusCode?: number;
  responseBody?: any;
}

export class IdempotencyManager {
  static async claimKey(
    client: pg.PoolClient,
    merchantId: string,
    operation: IdempotencyOperation,
    key: string,
    payload: any,
    transactionId?: string
  ): Promise<ClaimResult> {
    const requestHash = hashPayload(payload);

    // Advisory lock scoped to key
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `idem_${merchantId}_${operation}_${key}`
    ]);

    // Check existing
    const existing = await client.query<IdempotencyKeyRecord>(
      `SELECT * FROM idempotency_keys WHERE merchant_id = $1 AND operation = $2 AND key = $3 FOR UPDATE`,
      [merchantId, operation, key]
    );

    if (existing.rowCount && existing.rowCount > 0) {
      const record = existing.rows[0];
      if (record.request_hash !== requestHash) {
        throw new ConflictError(
          'Idempotency key has already been used with a different request payload.',
          'IDEMPOTENCY_KEY_REUSED',
          { merchant_id: merchantId, operation, key }
        );
      }

      if (record.status === 'PROCESSING') {
        throw new ConflictError(
          'A request with this idempotency key is currently being processed.',
          'IDEMPOTENCY_IN_PROGRESS',
          { merchant_id: merchantId, operation, key }
        );
      }

      if (record.status === 'COMPLETED') {
        return {
          isCached: true,
          statusCode: record.response_code || 200,
          responseBody: record.response_body
        };
      }

      if (record.status === 'UNKNOWN') {
        throw new ConflictError(
          'Previous attempt outcome is uncertain. Reconciling transaction.',
          'IDEMPOTENCY_UNCERTAIN_OUTCOME',
          { merchant_id: merchantId, operation, key }
        );
      }
    }

    // Insert new processing record
    await client.query(
      `
      INSERT INTO idempotency_keys (
        merchant_id, operation, key, request_hash, transaction_id, status, expires_at
      ) VALUES ($1, $2, $3, $4, $5, 'PROCESSING', NOW() + INTERVAL '24 hours')
      ON CONFLICT (merchant_id, operation, key) DO UPDATE SET
        status = 'PROCESSING',
        request_hash = EXCLUDED.request_hash,
        updated_at = NOW()
    `,
      [merchantId, operation, key, requestHash, transactionId || null]
    );

    return { isCached: false };
  }

  static async completeKey(
    client: pg.PoolClient,
    merchantId: string,
    operation: IdempotencyOperation,
    key: string,
    statusCode: number,
    responseBody: any,
    transactionId?: string
  ): Promise<void> {
    await client.query(
      `
      UPDATE idempotency_keys
      SET status = 'COMPLETED',
          response_code = $1,
          response_body = $2,
          transaction_id = COALESCE($3, transaction_id),
          updated_at = NOW()
      WHERE merchant_id = $4 AND operation = $5 AND key = $6
    `,
      [statusCode, JSON.stringify(responseBody), transactionId || null, merchantId, operation, key]
    );
  }

  static async failKey(
    client: pg.PoolClient,
    merchantId: string,
    operation: IdempotencyOperation,
    key: string,
    statusCode: number,
    errorBody: any
  ): Promise<void> {
    await client.query(
      `
      UPDATE idempotency_keys
      SET status = 'FAILED',
          response_code = $1,
          response_body = $2,
          updated_at = NOW()
      WHERE merchant_id = $3 AND operation = $4 AND key = $5
    `,
      [statusCode, JSON.stringify(errorBody), merchantId, operation, key]
    );
  }

  static async markUnknown(
    client: pg.PoolClient,
    merchantId: string,
    operation: IdempotencyOperation,
    key: string,
    statusCode: number,
    responseBody: any
  ): Promise<void> {
    await client.query(
      `
      UPDATE idempotency_keys
      SET status = 'UNKNOWN',
          response_code = $1,
          response_body = $2,
          updated_at = NOW()
      WHERE merchant_id = $3 AND operation = $4 AND key = $5
    `,
      [statusCode, JSON.stringify(responseBody), merchantId, operation, key]
    );
  }
}

