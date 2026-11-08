import pg from 'pg';
import { GatewayConfigRecord } from '../../shared/types/index.js';
import { NotFoundError } from '../../shared/errors/index.js';

export class GatewayConfigRepository {
  static async getAll(client: pg.PoolClient | pg.Pool): Promise<GatewayConfigRecord[]> {
    const res = await client.query<GatewayConfigRecord>(
      `SELECT * FROM gateway_config ORDER BY gateway_name ASC`
    );
    return res.rows;
  }

  static async getByName(
    client: pg.PoolClient | pg.Pool,
    name: string
  ): Promise<GatewayConfigRecord | null> {
    const res = await client.query<GatewayConfigRecord>(
      `SELECT * FROM gateway_config WHERE gateway_name = $1`,
      [name]
    );
    return res.rows[0] || null;
  }

  static async updateConfig(
    client: pg.PoolClient | pg.Pool,
    name: string,
    updates: Partial<GatewayConfigRecord>
  ): Promise<GatewayConfigRecord> {
    const current = await this.getByName(client, name);
    if (!current) {
      throw new NotFoundError(`Gateway config for ${name} not found`, 'GATEWAY_NOT_FOUND');
    }

    const res = await client.query<GatewayConfigRecord>(
      `
      UPDATE gateway_config
      SET enabled = COALESCE($1, enabled),
          fee_bps = COALESCE($2, fee_bps),
          fee_fixed_minor = COALESCE($3, fee_fixed_minor),
          rate_limit_per_second = COALESCE($4, rate_limit_per_second),
          request_timeout_ms = COALESCE($5, request_timeout_ms),
          breaker_failure_threshold = COALESCE($6, breaker_failure_threshold),
          breaker_cooldown_seconds = COALESCE($7, breaker_cooldown_seconds),
          updated_at = NOW()
      WHERE gateway_name = $8
      RETURNING *
    `,
      [
        updates.enabled ?? null,
        updates.fee_bps ?? null,
        updates.fee_fixed_minor ?? null,
        updates.rate_limit_per_second ?? null,
        updates.request_timeout_ms ?? null,
        updates.breaker_failure_threshold ?? null,
        updates.breaker_cooldown_seconds ?? null,
        name
      ]
    );

    return res.rows[0];
  }
}

