import crypto from 'crypto';
import { Request, Response } from 'express';
import { MockControlParser } from './mock-control.js';
import { MockStateStore } from './mock-state.store.js';

export class RazorpayMockController {
  static async handleAuthorize(req: Request, res: Response): Promise<void> {
    const controls = MockControlParser.parse(req);
    const override = MockStateStore.getGatewayOverride('razorpay');
    const isDown = controls.isGatewayDown || override?.isDown;
    const mode = controls.responseMode || override?.responseMode || 'success';
    const delay = controls.delayMs || override?.delayMs || 0;

    if (delay > 0) {
      await new Promise((r) => setTimeout(r, delay));
    }

    if (isDown) {
      res.status(503).json({ error: { code: 'GATEWAY_UNAVAILABLE', description: 'Razorpay service is currently down' } });
      return;
    }

    if (mode === 'timeout') {
      // 30s timeout per PDF B4.3 (can be aborted or delayed)
      const timeoutMs = req.header('X-Test-Timeout-Ms') ? parseInt(req.header('X-Test-Timeout-Ms')!, 10) : 30000;
      await new Promise((r) => setTimeout(r, Math.min(timeoutMs, 30000)));
      res.status(504).json({ error: { code: 'GATEWAY_TIMEOUT', description: 'Razorpay socket timeout' } });
      return;
    }

    if (mode === 'server-error') {
      res.status(502).json({ error: { code: 'BAD_GATEWAY', description: 'Razorpay upstream 502 Bad Gateway' } });
      return;
    }

    if (mode === 'rate-limit') {
      res.setHeader('Retry-After', String(controls.retryAfterSeconds));
      res.status(429).json({ error: { code: 'TOO_MANY_REQUESTS', description: 'Razorpay rate limit exceeded' } });
      return;
    }

    if (mode === 'decline') {
      res.status(400).json({
        error: {
          code: 'BAD_REQUEST_ERROR',
          description: 'Payment failed due to insufficient funds or card decline.',
          source: 'gateway',
          step: 'payment_authorization',
          reason: 'payment_failed'
        }
      });
      return;
    }

    // Success
    const { amount_minor, currency = 'INR', capture_mode = 'MANUAL', order_id } = req.body;
    const ref = `pay_rzp_${crypto.randomBytes(8).toString('hex')}`;
    const status = capture_mode === 'AUTO' ? 'CAPTURED' : 'AUTHORISED';

    MockStateStore.recordPayment({
      providerReference: ref,
      gateway: 'razorpay',
      amountMinor: String(amount_minor || '0'),
      currency,
      status,
      capturedMinor: status === 'CAPTURED' ? String(amount_minor || '0') : '0',
      refundedMinor: '0',
      orderId: order_id,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    res.status(200).json({
      id: ref,
      entity: 'payment',
      amount: Number(amount_minor || 0),
      currency,
      status: status.toLowerCase(),
      order_id: order_id || `order_${crypto.randomBytes(6).toString('hex')}`,
      method: req.body.payment_method?.toLowerCase() || 'card',
      captured: status === 'CAPTURED',
      created_at: Math.floor(Date.now() / 1000)
    });
  }

  static async handleCapture(req: Request, res: Response): Promise<void> {
    const controls = MockControlParser.parse(req);
    const override = MockStateStore.getGatewayOverride('razorpay');
    const isDown = controls.isGatewayDown || override?.isDown;
    const mode = controls.responseMode || override?.responseMode || 'success';
    const delay = controls.delayMs || override?.delayMs || 0;

    if (delay > 0) await new Promise((r) => setTimeout(r, delay));

    if (isDown) {
      res.status(503).json({ error: { code: 'GATEWAY_UNAVAILABLE', description: 'Razorpay service is currently down' } });
      return;
    }

    if (mode === 'server-error') {
      res.status(502).json({ error: { code: 'BAD_GATEWAY', description: 'Razorpay 502 Bad Gateway during capture' } });
      return;
    }

    const { payment_id, amount_minor } = req.body;
    const existing = MockStateStore.getPayment(payment_id);
    const captureAmt = String(amount_minor || existing?.amountMinor || '0');

    if (existing) {
      MockStateStore.updatePaymentStatus(payment_id, 'CAPTURED', captureAmt);
    }

    res.status(200).json({
      id: payment_id,
      entity: 'payment',
      status: 'captured',
      amount: Number(captureAmt),
      captured: true
    });
  }

  static async handleRefund(req: Request, res: Response): Promise<void> {
    const { payment_id, amount_minor } = req.body;
    const existing = MockStateStore.getPayment(payment_id);
    const refundId = `rfnd_rzp_${crypto.randomBytes(8).toString('hex')}`;
    const refundAmt = String(amount_minor || existing?.capturedMinor || '0');

    if (existing) {
      MockStateStore.updatePaymentStatus(payment_id, 'REFUNDED', undefined, refundAmt);
    }

    res.status(200).json({
      id: refundId,
      entity: 'refund',
      payment_id,
      amount: Number(refundAmt),
      status: 'processed',
      created_at: Math.floor(Date.now() / 1000)
    });
  }
}

