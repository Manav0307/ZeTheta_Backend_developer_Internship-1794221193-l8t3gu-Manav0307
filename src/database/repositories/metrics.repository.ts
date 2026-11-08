import pg from 'pg';
import { PaymentMethod } from '../../shared/types/index.js';

export class MetricsRepository {
  static async recordAttemptOutcome(
    client: pg.PoolClient | pg.Pool,
    gateway: string,
    method: PaymentMethod,
    latencyMs: number,
    isSuccess: boolean
  ): Promise<void> {
    const windowStart = new Date();
    windowStart.setSeconds(0, 0); // truncate to current minute

    await client.query(
      `
      INSERT INTO gateway_health_metrics (
        gateway, payment_method, window_start, total_count, success_count,
        error_count, p95_latency_ms
      ) VALUES ($1, $2, $3, 1, $4, $5, $6)
      ON CONFLICT (gateway, payment_method, window_start) DO UPDATE SET
        total_count = gateway_health_metrics.total_count + 1,
        success_count = gateway_health_metrics.success_count + $4,
        error_count = gateway_health_metrics.error_count + $5,
        p95_latency_ms = GREATEST(gateway_health_metrics.p95_latency_ms, $6),
        recorded_at = NOW()
    `,
      [
        gateway,
        method,
        windowStart.toISOString(),
        isSuccess ? 1 : 0,
        isSuccess ? 0 : 1,
        latencyMs
      ]
    );
  }

  static async getRollingStats(
    client: pg.PoolClient | pg.Pool,
    gateway: string,
    method: PaymentMethod,
    windowMinutes: number = 15
  ): Promise<{
    total_count: number;
    success_count: number;
    p95_latency_ms: number;
    error_count: number;
  }> {
    const res = await client.query<{
      total: string | null;
      success: string | null;
      p95: number | null;
      err: string | null;
    }>(
      `
      SELECT
        COALESCE(SUM(total_count), 0) as total,
        COALESCE(SUM(success_count), 0) as success,
        COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY p95_latency_ms), 300) as p95,
        COALESCE(SUM(error_count), 0) as err
      FROM gateway_health_metrics
      WHERE gateway = $1 AND payment_method = $2
        AND recorded_at >= NOW() - ($3 || ' minutes')::INTERVAL
    `,
      [gateway, method, windowMinutes]
    );

    const row = res.rows[0];
    const total = parseInt(row?.total || '0', 10);
    const success = parseInt(row?.success || '0', 10);
    const p95 = Math.round(Number(row?.p95 || 300));
    const errorCount = parseInt(row?.err || '0', 10);

    return {
      total_count: total,
      success_count: success,
      p95_latency_ms: p95,
      error_count: errorCount
    };
  }

  static async getSuccessRateAnalytics(
    client: pg.PoolClient | pg.Pool,
    timeRangeMinutes: number = 60
  ): Promise<any[]> {
    const res = await client.query(
      `
      SELECT
        gateway,
        payment_method,
        COALESCE(SUM(total_count), 0)::BIGINT as total_transactions,
        COALESCE(SUM(success_count), 0)::BIGINT as successful_transactions,
        CASE
          WHEN SUM(total_count) > 0 THEN ROUND((SUM(success_count)::NUMERIC / SUM(total_count)::NUMERIC) * 100, 2)
          ELSE 0
        END as success_rate_percentage,
        ROUND(COALESCE(AVG(p95_latency_ms), 0)) as avg_p95_latency_ms
      FROM gateway_health_metrics
      WHERE recorded_at >= NOW() - ($1 || ' minutes')::INTERVAL
      GROUP BY gateway, payment_method
      ORDER BY gateway ASC, payment_method ASC
    `,
      [timeRangeMinutes]
    );
    return res.rows;
  }

  static async getVolumeAnalytics(
    client: pg.PoolClient | pg.Pool,
    timeRangeMinutes: number = 60
  ): Promise<any[]> {
    const res = await client.query(
      `
      SELECT
        gateway,
        payment_method,
        COALESCE(SUM(total_count), 0)::BIGINT as volume,
        COALESCE(SUM(success_count), 0)::BIGINT as completed_volume,
        COALESCE(SUM(error_count), 0)::BIGINT as error_volume
      FROM gateway_health_metrics
      WHERE recorded_at >= NOW() - ($1 || ' minutes')::INTERVAL
      GROUP BY gateway, payment_method
      ORDER BY gateway ASC, payment_method ASC
    `,
      [timeRangeMinutes]
    );
    return res.rows;
  }
}

