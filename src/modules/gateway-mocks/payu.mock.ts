import crypto from 'crypto';
import { Request, Response } from 'express';
import { MockControlParser } from './mock-control.js';
import { MockStateStore } from './mock-state.store.js';

export class PayUMockController {
  private static captureAttemptCount: Map<string, number> = new Map();

  static getCaptureAttemptCount(paymentId: string): number {
    return this.captureAttemptCount.get(paymentId) || 0;
  }

  static resetCaptureAttemptCount(paymentId?: string): void {
    if (paymentId) this.captureAttemptCount.delete(paymentId);
    else this.captureAttemptCount.clear();
  }

  static async handleAuthorize(req: Request, res: Response): Promise<void> {
    const controls = MockControlParser.parse(req);
    const override = MockStateStore.getGatewayOverride('payu');
    const isDown = controls.isGatewayDown || override?.isDown;
    const mode = controls.responseMode || override?.responseMode || 'success';
    const delay = controls.delayMs || override?.delayMs || 0;

    if (delay > 0) await new Promise((r) => setTimeout(r, delay));

    if (isDown) {
      res.status(503).json({ status: 'failure', msg: 'PayU service down' });
      return;
    }

    if (mode === 'timeout') {
      const timeoutMs = req.header('X-Test-Timeout-Ms') ? parseInt(req.header('X-Test-Timeout-Ms')!, 10) : 30000;
      await new Promise((r) => setTimeout(r, Math.min(timeoutMs, 30000)));
      res.status(504).json({ status: 'failure', msg: 'PayU gateway timeout' });
      return;
    }

    if (mode === 'server-error') {
      res.status(502).json({ status: 'failure', msg: 'PayU 502 Bad Gateway' });
      return;
    }

    if (mode === 'rate-limit') {
      res.setHeader('Retry-After', String(controls.retryAfterSeconds));
      res.status(429).json({ status: 'failure', msg: 'PayU Rate limit exceeded' });
      return;
    }

    if (mode === 'decline') {
      res.status(200).json({
        status: 'failure',
        unmappedstatus: 'failed',
        error_code: 'E301',
        error_Message: 'Bank decline / Insufficient funds'
      });
      return;
    }

    // Success
    const { amount, txnid = `tx_${Date.now()}` } = req.body;
    const ref = `payu_${crypto.randomBytes(8).toString('hex')}`;

    MockStateStore.recordPayment({
      providerReference: ref,
      gateway: 'payu',
      amountMinor: String(amount || '0'),
      currency: 'INR',
      status: 'AUTHORISED',
      capturedMinor: '0',
      refundedMinor: '0',
      orderId: txnid,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    res.status(200).json({
      status: 'success',
      mihpayid: ref,
      txnid,
      amount,
      mode: 'CC',
      bank_ref_num: `bk_${crypto.randomBytes(6).toString('hex')}`
    });
  }

  static async handleCapture(req: Request, res: Response): Promise<void> {
    const controls = MockControlParser.parse(req);
    const override = MockStateStore.getGatewayOverride('payu');
    const isDown = controls.isGatewayDown || override?.isDown;
    const mode = controls.responseMode || override?.responseMode || 'success';
    const delay = controls.delayMs || override?.delayMs || 0;

    const { mihpayid, amount } = req.body;
    const attempts = (this.captureAttemptCount.get(mihpayid) || 0) + 1;
    this.captureAttemptCount.set(mihpayid, attempts);

    if (delay > 0) await new Promise((r) => setTimeout(r, delay));

    if (isDown) {
      res.status(503).json({ status: 'failure', msg: 'PayU service down' });
      return;
    }

    if (mode === 'server-error') {
      // In FS-04: capture returns HTTP 502 Bad Gateway
      res.status(502).json({
        status: 'failure',
        error: '502 Bad Gateway from PayU upstream'
      });
      return;
    }

    // Default successful capture
    const existing = MockStateStore.getPayment(mihpayid);
    const captureAmt = String(amount || existing?.amountMinor || '0');
    if (existing) {
      MockStateStore.updatePaymentStatus(mihpayid, 'CAPTURED', captureAmt);
    }

    res.status(200).json({
      status: 'success',
      mihpayid,
      amount: captureAmt,
      action: 'capture'
    });
  }

  static async handleRefund(req: Request, res: Response): Promise<void> {
    const { mihpayid, amount } = req.body;
    const refundId = `rfnd_payu_${crypto.randomBytes(8).toString('hex')}`;
    const refundAmt = String(amount || '0');

    MockStateStore.updatePaymentStatus(mihpayid, 'REFUNDED', undefined, refundAmt);

    res.status(200).json({
      status: 'success',
      request_id: refundId,
      mihpayid,
      amount: refundAmt,
      msg: 'Refund initiated successfully'
    });
  }

  static async handleStatus(req: Request, res: Response): Promise<void> {
    const providerReference = String(req.params.providerReference);
    const payment = MockStateStore.getPayment(providerReference);
    
    // Check if scenario forced late success
    const isLateSuccess = MockStateStore.getScenarioParam<boolean>(`late_success_${providerReference}`);

    if (isLateSuccess) {
      if (payment) {
        MockStateStore.updatePaymentStatus(providerReference, 'CAPTURED', payment.amountMinor);
      }
      res.status(200).json({
        status: 'success',
        mihpayid: providerReference,
        transaction_status: 'CAPTURED',
        amount: payment?.amountMinor || '0'
      });
      return;
    }

    if (!payment) {
      res.status(404).json({ status: 'failure', msg: 'Payment not found on PayU' });
      return;
    }

    res.status(200).json({
      status: 'success',
      mihpayid: providerReference,
      transaction_status: payment.status,
      amount: payment.amountMinor,
      captured_amount: payment.capturedMinor
    });
  }
}

