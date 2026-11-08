import pg from 'pg';
import { RoutingConfigRecord } from '../../shared/types/index.js';
import { BadRequestError } from '../../shared/errors/index.js';

export class RoutingConfigRepository {
  static async getConfig(client: pg.PoolClient | pg.Pool): Promise<RoutingConfigRecord> {
    const res = await client.query<RoutingConfigRecord>(
      `SELECT * FROM routing_config WHERE id = 1`
    );
    return res.rows[0];
  }

  static async updateConfig(
    client: pg.PoolClient,
    weights: {
      weight_success: number;
      weight_latency: number;
      weight_cost: number;
      weight_health: number;
      weight_method_fit: number;
      metric_window_minutes?: number;
      degraded_preference_threshold?: number;
    }
  ): Promise<RoutingConfigRecord> {
    const sum =
      weights.weight_success +
      weights.weight_latency +
      weights.weight_cost +
      weights.weight_health +
      weights.weight_method_fit;

    if (Math.abs(sum - 1.0) > 0.0001) {
      throw new BadRequestError(
        `Routing weights must sum to exactly 1.0 (current sum: ${sum})`,
        'INVALID_ROUTING_WEIGHTS'
      );
    }

    const res = await client.query<RoutingConfigRecord>(
      `
      UPDATE routing_config
      SET weight_success = $1,
          weight_latency = $2,
          weight_cost = $3,
          weight_health = $4,
          weight_method_fit = $5,
          metric_window_minutes = COALESCE($6, metric_window_minutes),
          degraded_preference_threshold = COALESCE($7, degraded_preference_threshold),
          revision = revision + 1,
          updated_at = NOW()
      WHERE id = 1
      RETURNING *
    `,
      [
        weights.weight_success,
        weights.weight_latency,
        weights.weight_cost,
        weights.weight_health,
        weights.weight_method_fit,
        weights.metric_window_minutes ?? null,
        weights.degraded_preference_threshold ?? null
      ]
    );

    return res.rows[0];
  }
}

