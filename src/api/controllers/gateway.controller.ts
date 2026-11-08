import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getPool } from '../../database/connection.js';
import { GatewayConfigRepository } from '../../database/repositories/gateway-config.repository.js';
import { CircuitBreakerRepository } from '../../database/repositories/circuit-breaker.repository.js';
import { MetricsRepository } from '../../database/repositories/metrics.repository.js';
import { OutboundRateLimiter } from '../../modules/rate-limiter/index.js';
import { NotFoundError } from '../../shared/errors/index.js';

const updateGatewayConfigSchema = z.object({
  enabled: z.boolean().optional(),
  fee_bps: z.number().int().min(0).optional(),
  fee_fixed_minor: z.string().regex(/^\d+$/).optional(),
  rate_limit_per_second: z.number().int().positive().optional(),
  request_timeout_ms: z.number().int().positive().optional(),
  breaker_failure_threshold: z.number().int().positive().optional(),
  breaker_cooldown_seconds: z.number().int().positive().optional()
});

export class GatewayController {
  static async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const pool = getPool();
      const gateways = await GatewayConfigRepository.getAll(pool);
      res.status(200).json({ gateways });
    } catch (err) {
      next(err);
    }
  }

  static async getHealth(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const name = Array.isArray(req.params.name) ? req.params.name[0] : req.params.name;
      const pool = getPool();
      const config = await GatewayConfigRepository.getByName(pool, name);
      if (!config) {
        throw new NotFoundError(`Gateway ${name} not found`, 'GATEWAY_NOT_FOUND');
      }

      const allBreakers = await CircuitBreakerRepository.getAllBreakers(pool);
      const gatewayBreakers = allBreakers.filter(
        (b) => b.gateway.toLowerCase() === name.toLowerCase()
      );

      const rateUtilization = OutboundRateLimiter.getUtilization(name);

      res.status(200).json({
        gateway: name,
        enabled: config.enabled,
        rate_limiter: {
          limit: rateUtilization.limit,
          current: rateUtilization.current,
          utilization: rateUtilization.text
        },
        circuit_breakers: gatewayBreakers.map((b) => ({
          payment_method: b.payment_method,
          state: b.state,
          consecutive_failures: b.consecutive_failures,
          opened_until: b.opened_until
        }))
      });
    } catch (err) {
      next(err);
    }
  }

  static async getMetrics(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const name = Array.isArray(req.params.name) ? req.params.name[0] : req.params.name;
      const pool = getPool();
      const config = await GatewayConfigRepository.getByName(pool, name);
      if (!config) {
        throw new NotFoundError(`Gateway ${name} not found`, 'GATEWAY_NOT_FOUND');
      }

      const minutes = parseInt((req.query.window_minutes as string) || '60', 10);
      const cardStats = await MetricsRepository.getRollingStats(pool, name, 'CARD', minutes);
      const upiStats = await MetricsRepository.getRollingStats(pool, name, 'UPI', minutes);
      const netbankingStats = await MetricsRepository.getRollingStats(pool, name, 'NETBANKING', minutes);

      const rateUtilization = OutboundRateLimiter.getUtilization(name);

      res.status(200).json({
        gateway: name,
        window_minutes: minutes,
        rate_limit_utilization: rateUtilization.text,
        methods: {
          CARD: cardStats,
          UPI: upiStats,
          NETBANKING: netbankingStats
        }
      });
    } catch (err) {
      next(err);
    }
  }

  static async updateConfig(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const name = Array.isArray(req.params.name) ? req.params.name[0] : req.params.name;
      const body = updateGatewayConfigSchema.parse(req.body);
      const pool = getPool();

      const updated = await GatewayConfigRepository.updateConfig(pool, name, body);
      res.status(200).json({ gateway: name, config: updated });
    } catch (err) {
      next(err);
    }
  }
}
