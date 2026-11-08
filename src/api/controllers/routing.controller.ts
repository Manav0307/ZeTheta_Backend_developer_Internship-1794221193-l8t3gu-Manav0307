import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { withTransaction, getPool } from '../../database/connection.js';
import { RoutingConfigRepository } from '../../database/repositories/routing-config.repository.js';

const updateRoutingConfigSchema = z.object({
  weight_success: z.number().min(0).max(1),
  weight_latency: z.number().min(0).max(1),
  weight_cost: z.number().min(0).max(1),
  weight_health: z.number().min(0).max(1),
  weight_method_fit: z.number().min(0).max(1),
  metric_window_minutes: z.number().int().positive().optional(),
  degraded_preference_threshold: z.number().min(0).max(1).optional()
});

export class RoutingController {
  static async getConfig(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const pool = getPool();
      const config = await RoutingConfigRepository.getConfig(pool);
      res.status(200).json({ config });
    } catch (err) {
      next(err);
    }
  }

  static async updateConfig(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = updateRoutingConfigSchema.parse(req.body);

      const updated = await withTransaction(async (client) => {
        return RoutingConfigRepository.updateConfig(client, body);
      });

      res.status(200).json({ config: updated });
    } catch (err) {
      next(err);
    }
  }
}

