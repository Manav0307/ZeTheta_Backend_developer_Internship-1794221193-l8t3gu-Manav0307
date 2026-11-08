import { Request, Response, NextFunction } from 'express';
import { WebhookService } from '../../modules/webhooks/webhook.service.js';
import { BadRequestError } from '../../shared/errors/index.js';

export class WebhookController {
  private static async handleGatewayWebhook(
    gateway: string,
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body));
      if (!rawBody || rawBody.length === 0) {
        throw new BadRequestError('Empty webhook request body', 'EMPTY_BODY');
      }

      const result = await WebhookService.ingestWebhook(gateway, rawBody, req.headers);
      res.status(200).json({
        status: 'acknowledged',
        gateway,
        event_id: result.eventId,
        duplicate: result.duplicate
      });
    } catch (err) {
      next(err);
    }
  }

  static async handleRazorpay(req: Request, res: Response, next: NextFunction): Promise<void> {
    return WebhookController.handleGatewayWebhook('razorpay', req, res, next);
  }

  static async handleStripe(req: Request, res: Response, next: NextFunction): Promise<void> {
    return WebhookController.handleGatewayWebhook('stripe', req, res, next);
  }

  static async handlePayU(req: Request, res: Response, next: NextFunction): Promise<void> {
    return WebhookController.handleGatewayWebhook('payu', req, res, next);
  }

  static async handleUpi(req: Request, res: Response, next: NextFunction): Promise<void> {
    return WebhookController.handleGatewayWebhook('upi', req, res, next);
  }
}

