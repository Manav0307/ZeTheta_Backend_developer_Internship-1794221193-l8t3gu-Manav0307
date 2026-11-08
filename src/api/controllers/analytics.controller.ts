import { Request, Response, NextFunction } from 'express';
import { getPool } from '../../database/connection.js';
import { MetricsRepository } from '../../database/repositories/metrics.repository.js';

export class AnalyticsController {
  static async getSuccessRate(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const minutes = parseInt((req.query.time_range_minutes as string) || '60', 10);
      const pool = getPool();
      const analytics = await MetricsRepository.getSuccessRateAnalytics(pool, minutes);
      res.status(200).json({
        time_range_minutes: minutes,
        data: analytics
      });
    } catch (err) {
      next(err);
    }
  }

  static async getVolume(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const minutes = parseInt((req.query.time_range_minutes as string) || '60', 10);
      const pool = getPool();
      const volume = await MetricsRepository.getVolumeAnalytics(pool, minutes);
      res.status(200).json({
        time_range_minutes: minutes,
        data: volume
      });
    } catch (err) {
      next(err);
    }
  }
}

