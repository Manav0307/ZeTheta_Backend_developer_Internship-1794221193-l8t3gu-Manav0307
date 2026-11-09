import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { PaymentApplicationService } from '../../modules/payments/payment.service.js';
import { BadRequestError } from '../../shared/errors/index.js';

const createPaymentSchema = z.object({
  merchant_order_id: z.string().min(1, 'merchant_order_id is required'),
  amount_minor: z.string().regex(/^\d+$/, 'amount_minor must be a positive integer string'),
  currency: z.string().length(3).default('INR'),
  payment_method: z.enum(['CARD', 'UPI', 'NETBANKING']),
  capture_method: z.enum(['MANUAL', 'AUTOMATIC']).optional().default('MANUAL'),
  metadata: z.record(z.string(), z.any()).optional()
});

const capturePaymentSchema = z.object({
  amount_minor: z.string().regex(/^\d+$/).optional()
});

const refundPaymentSchema = z.object({
  amount_minor: z.string().regex(/^\d+$/).optional(),
  reason: z.string().optional()
});

export class PaymentController {
  static async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const idempotencyKey = req.header('idempotency-key');
      if (!idempotencyKey) {
        throw new BadRequestError('Idempotency-Key header is required for creating a payment', 'MISSING_IDEMPOTENCY_KEY');
      }

      const body = createPaymentSchema.parse(req.body);
      const result = await PaymentApplicationService.initiatePayment({
        merchantId: req.merchantId || 'merchant_demo_1',
        merchantOrderId: body.merchant_order_id,
        paymentMethod: body.payment_method,
        currency: body.currency,
        amountMinor: body.amount_minor,
        captureMode: body.capture_method,
        idempotencyKey,
        traceId: req.traceId,
        metadata: body.metadata
      });

      res.status(result.statusCode).json(result.body);
    } catch (err) {
      next(err);
    }
  }

  static async getByIdOrOrder(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const { merchant_order_id } = req.query;

      if (id) {
        const payment = await PaymentApplicationService.getPaymentById(id, req.merchantId);
        res.status(200).json(payment);
        return;
      }

      if (merchant_order_id && typeof merchant_order_id === 'string') {
        const payment = await PaymentApplicationService.getPaymentByMerchantOrderId(
          merchant_order_id,
          req.merchantId
        );
        res.status(200).json(payment);
        return;
      }

      throw new BadRequestError('Either payment id or merchant_order_id parameter is required', 'BAD_REQUEST');
    } catch (err) {
      next(err);
    }
  }

  static async capture(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const idempotencyKey = req.header('idempotency-key');
      if (!idempotencyKey) {
        throw new BadRequestError('Idempotency-Key header is required for capturing a payment', 'MISSING_IDEMPOTENCY_KEY');
      }

      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const body = capturePaymentSchema.parse(req.body);

      const result = await PaymentApplicationService.capturePayment({
        merchantId: req.merchantId || 'merchant_demo_1',
        transactionId: id,
        amountMinor: body.amount_minor,
        idempotencyKey,
        traceId: req.traceId
      });

      res.status(result.statusCode).json(result.body);
    } catch (err) {
      next(err);
    }
  }

  static async void(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const idempotencyKey = req.header('idempotency-key');
      if (!idempotencyKey) {
        throw new BadRequestError('Idempotency-Key header is required for voiding a payment', 'MISSING_IDEMPOTENCY_KEY');
      }

      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const result = await PaymentApplicationService.voidPayment({
        merchantId: req.merchantId || 'merchant_demo_1',
        transactionId: id,
        idempotencyKey,
        traceId: req.traceId
      });

      res.status(result.statusCode).json(result.body);
    } catch (err) {
      next(err);
    }
  }

  static async refund(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const idempotencyKey = req.header('idempotency-key');
      if (!idempotencyKey) {
        throw new BadRequestError('Idempotency-Key header is required for refunding a payment', 'MISSING_IDEMPOTENCY_KEY');
      }

      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const body = refundPaymentSchema.parse(req.body);

      const result = await PaymentApplicationService.refundPayment({
        merchantId: req.merchantId || 'merchant_demo_1',
        transactionId: id,
        amountMinor: body.amount_minor,
        reason: body.reason,
        idempotencyKey,
        traceId: req.traceId
      });

      res.status(result.statusCode).json(result.body);
    } catch (err) {
      next(err);
    }
  }

  static async getRefunds(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const refunds = await PaymentApplicationService.getRefunds(id);
      res.status(200).json({ payment_id: id, refunds });
    } catch (err) {
      next(err);
    }
  }

  static async getTimeline(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const timeline = await PaymentApplicationService.getTimeline(id);
      res.status(200).json({ payment_id: id, timeline });
    } catch (err) {
      next(err);
    }
  }

  static async transition(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const targetState = req.body.targetState || req.body.target_state;
      if (!targetState) {
        throw new BadRequestError('targetState is required', 'MISSING_TARGET_STATE');
      }

      const result = await PaymentApplicationService.transitionManualState({
        transactionId: id,
        targetState,
        traceId: req.traceId
      });

      res.status(result.statusCode).json(result.body);
    } catch (err) {
      next(err);
    }
  }

  static async expire(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const result = await PaymentApplicationService.expirePayment({
        transactionId: id,
        merchantId: req.merchantId,
        traceId: req.traceId
      });

      res.status(result.statusCode).json(result.body);
    } catch (err) {
      next(err);
    }
  }

  static async voidRemainder(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const result = await PaymentApplicationService.voidRemainder({
        transactionId: id,
        merchantId: req.merchantId,
        traceId: req.traceId
      });

      res.status(result.statusCode).json(result.body);
    } catch (err) {
      next(err);
    }
  }
}

