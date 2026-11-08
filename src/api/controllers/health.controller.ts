import { Request, Response, NextFunction } from 'express';
import { checkDatabaseHealth } from '../../database/connection.js';

export class HealthController {
  static async check(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const dbHealth = await checkDatabaseHealth();
      const isHealthy = dbHealth.healthy;

      const responsePayload = {
        status: isHealthy ? 'healthy' : 'unhealthy',
        timestamp: new Date().toISOString(),
        uptime_seconds: process.uptime(),
        database: {
          status: dbHealth.healthy ? 'connected' : 'disconnected',
          name: dbHealth.database,
          latency_ms: dbHealth.latency_ms,
          error: dbHealth.error
        }
      };

      res.status(isHealthy ? 200 : 503).json(responsePayload);
    } catch (err) {
      next(err);
    }
  }
}

