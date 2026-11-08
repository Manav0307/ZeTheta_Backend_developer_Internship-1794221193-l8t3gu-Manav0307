import { Request, Response, NextFunction } from 'express';
import { WebhookService } from '../../modules/webhooks/webhook.service.js';

export class AdminDlqController {
  static async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const items = await WebhookService.listDlq();
      res.status(200).json({ dlq_items: items, count: items.length });
    } catch (err) {
      next(err);
    }
  }

  static async replay(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      await WebhookService.replayDlqItem(id);
      res.status(200).json({ status: 'replayed', id });
    } catch (err) {
      next(err);
    }
  }
}
