import crypto from 'crypto';
import { Request, Response } from 'express';
import { MockControlParser } from './mock-control.js';
import { MockStateStore } from './mock-state.store.js';

export class StripeMockController {
  static async handleAuthorize(req: Request, res: Response): Promise<void> {
    const controls = MockControlParser.parse(req);
    const override = MockStateStore.getGatewayOverride('stripe');
    const isDown = controls.isGatewayDown || override?.isDown;
    const mode = controls.responseMode || override?.responseMode || 'success';
    const delay = controls.delayMs || override?.delayMs || 0;

    if (delay > 0) await new Promise((r) => setTimeout(r, delay));

    if (isDown) {
      res.status(503).json({ error: { type: 'api_connection_error', message: 'Stripe service unavailable' } });
      return;
    }

    if (mode === 'timeout') {
      const timeoutMs = req.header('X-Test-Timeout-Ms') ? parseInt(req.header('X-Test-Timeout-Ms')!, 10) : 30000;
      await new Promise((r) => setTimeout(r, Math.min(timeoutMs, 30000)));
      res.status(504).json({ error: { type: 'api_error', message: 'Stripe request timed out' } });
      return;
    }

    if (mode === 'server-error') {
      res.status(502).json({ error: { type: 'api_error', message: 'Stripe 502 Bad Gateway' } });
      return;
    }

    if (mode === 'rate-limit') {
      res.setHeader('Retry-After', String(controls.retryAfterSeconds));
      res.status(429).json({ error: { type: 'rate_limit_error', message: 'Stripe rate limit exceeded. Too many requests.' } });
      return;
    }

    if (mode === 'decline') {
      res.status(402).json({
        error: {
          type: 'card_error',
          code: 'card_declined',
          decline_code: 'generic_decline',
          message: 'Your card was declined.'
        }
      });
      return;
    }

    // Success
    const { amount_minor, currency = 'inr', capture_mode = 'MANUAL' } = req.body;
    const ref = `pi_str_${crypto.randomBytes(12).toString('hex')}`;
    const status = capture_mode === 'AUTO' ? 'CAPTURED' : 'AUTHORISED';

    MockStateStore.recordPayment({
      providerReference: ref,
      gateway: 'stripe',
      amountMinor: String(amount_minor || '0'),
      currency,
      status,
      capturedMinor: status === 'CAPTURED' ? String(amount_minor || '0') : '0',
      refundedMinor: '0',
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    res.status(200).json({
      id: ref,
      object: 'payment_intent',
      amount: Number(amount_minor || 0),
      currency: currency.toLowerCase(),
      status: status === 'CAPTURED' ? 'succeeded' : 'requires_capture',
      client_secret: `${ref}_secret_${crypto.randomBytes(8).toString('hex')}`
    });
  }

  static async handleCapture(req: Request, res: Response): Promise<void> {
    const controls = MockControlParser.parse(req);
    const override = MockStateStore.getGatewayOverride('stripe');
    const isDown = controls.isGatewayDown || override?.isDown;
    const mode = controls.responseMode || override?.responseMode || 'success';
    const delay = controls.delayMs || override?.delayMs || 0;

    if (delay > 0) await new Promise((r) => setTimeout(r, delay));

    if (isDown) {
      res.status(503).json({ error: { type: 'api_connection_error', message: 'Stripe service unavailable' } });
      return;
    }

    if (mode === 'server-error') {
      res.status(502).json({ error: { type: 'api_error', message: 'Stripe capture 502 error' } });
      return;
    }

    const { payment_intent_id, amount_to_capture } = req.body;
    const existing = MockStateStore.getPayment(payment_intent_id);
    const captureAmt = String(amount_to_capture || existing?.amountMinor || '0');

    if (existing) {
      MockStateStore.updatePaymentStatus(payment_intent_id, 'CAPTURED', captureAmt);
    }

    res.status(200).json({
      id: payment_intent_id,
      object: 'payment_intent',
      status: 'succeeded',
      amount_captured: Number(captureAmt)
    });
  }

  static async handleVoid(req: Request, res: Response): Promise<void> {
    const { payment_intent_id } = req.body;
    MockStateStore.updatePaymentStatus(payment_intent_id, 'VOIDED');
    res.status(200).json({
      id: payment_intent_id,
      object: 'payment_intent',
      status: 'canceled',
      cancellation_reason: 'requested_by_customer'
    });
  }

  static async handleRefund(req: Request, res: Response): Promise<void> {
    const { payment_intent_id, amount } = req.body;
    const refundId = `re_str_${crypto.randomBytes(12).toString('hex')}`;
    const refundAmt = String(amount || '0');

    MockStateStore.updatePaymentStatus(payment_intent_id, 'REFUNDED', undefined, refundAmt);

    res.status(200).json({
      id: refundId,
      object: 'refund',
      payment_intent: payment_intent_id,
      amount: Number(refundAmt),
      status: 'succeeded'
    });
  }
}

