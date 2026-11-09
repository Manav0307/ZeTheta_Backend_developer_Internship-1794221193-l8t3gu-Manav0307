import crypto from 'crypto';
import { Request, Response } from 'express';
import { MockControlParser } from './mock-control.js';
import { MockStateStore } from './mock-state.store.js';

export class UpiMockController {
  static async handleAuthorize(req: Request, res: Response): Promise<void> {
    const controls = MockControlParser.parse(req);
    const override = MockStateStore.getGatewayOverride('upi');
    const isDown = controls.isGatewayDown || override?.isDown;
    const mode = controls.responseMode || override?.responseMode || 'success';
    const delay = controls.delayMs || override?.delayMs || 0;

    if (delay > 0) await new Promise((r) => setTimeout(r, delay));

    if (isDown) {
      res.status(503).json({ success: false, responseCode: 'U53', message: 'UPI switch offline' });
      return;
    }

    if (mode === 'timeout') {
      const timeoutMs = req.header('X-Test-Timeout-Ms') ? parseInt(req.header('X-Test-Timeout-Ms')!, 10) : 30000;
      await new Promise((r) => setTimeout(r, Math.min(timeoutMs, 30000)));
      res.status(504).json({ success: false, responseCode: 'U96', message: 'UPI PSP timeout' });
      return;
    }

    if (mode === 'server-error') {
      res.status(502).json({ success: false, responseCode: 'U52', message: 'UPI 502 Bad Gateway' });
      return;
    }

    if (mode === 'rate-limit') {
      res.setHeader('Retry-After', String(controls.retryAfterSeconds));
      res.status(429).json({ success: false, responseCode: 'U429', message: 'UPI rate limit exceeded' });
      return;
    }

    if (mode === 'decline') {
      res.status(200).json({
        success: false,
        responseCode: 'ZM',
        message: 'Invalid MPIN / User declined collect request'
      });
      return;
    }

    const { amount_minor, vpa, flow_type = 'DIRECT' } = req.body;
    const ref = `upi_txn_${crypto.randomBytes(8).toString('hex')}`;
    const npciRrn = `${Date.now()}`.slice(-12);

    // If flow is collect and marked to expire
    const isCollectExpired = req.header('X-Mock-Upi-Expired') === 'true' || MockStateStore.getScenarioParam<boolean>('upi_collect_expired');
    const status = isCollectExpired ? 'EXPIRED' : (flow_type === 'COLLECT' ? 'AUTHORISED' : 'CAPTURED');

    MockStateStore.recordPayment({
      providerReference: ref,
      gateway: 'upi',
      amountMinor: String(amount_minor || '0'),
      currency: 'INR',
      status: status === 'EXPIRED' ? 'EXPIRED' : status,
      capturedMinor: status === 'CAPTURED' ? String(amount_minor || '0') : '0',
      refundedMinor: '0',
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    if (isCollectExpired) {
      res.status(200).json({
        success: false,
        responseCode: 'EXPIRED',
        message: 'UPI collect mandate expired unapproved by customer',
        txnId: ref,
        npciRrn
      });
      return;
    }

    res.status(200).json({
      success: true,
      responseCode: '00',
      message: 'Transaction Successful',
      txnId: ref,
      npciRrn,
      vpa: vpa || 'customer@okaxis',
      amount: Number(amount_minor || 0),
      status: status === 'CAPTURED' ? 'SUCCESS' : 'PENDING'
    });
  }

  static async handleStatus(req: Request, res: Response): Promise<void> {
    const providerReference = String(req.params.providerReference);
    const payment = MockStateStore.getPayment(providerReference);
    const isExpired = req.header('X-Mock-Upi-Expired') === 'true' || MockStateStore.getScenarioParam<boolean>(`upi_expired_${providerReference}`);

    if (isExpired) {
      if (payment) payment.status = 'EXPIRED';
      res.status(200).json({
        success: false,
        txnId: providerReference,
        status: 'EXPIRED',
        responseCode: 'EXPIRED',
        message: 'UPI collect request expired unapproved'
      });
      return;
    }

    if (!payment) {
      res.status(404).json({ success: false, message: 'UPI transaction not found' });
      return;
    }

    res.status(200).json({
      success: payment.status === 'CAPTURED' || payment.status === 'AUTHORISED',
      txnId: providerReference,
      status: payment.status === 'CAPTURED' ? 'SUCCESS' : payment.status,
      responseCode: payment.status === 'CAPTURED' ? '00' : 'U01',
      amount: payment.amountMinor
    });
  }

  static async handleRefund(req: Request, res: Response): Promise<void> {
    const { txn_id, amount_minor } = req.body;
    const refundRef = `rfnd_upi_${crypto.randomBytes(8).toString('hex')}`;
    MockStateStore.updatePaymentStatus(txn_id, 'REFUNDED', undefined, String(amount_minor || '0'));

    res.status(200).json({
      success: true,
      responseCode: '00',
      refundTxnId: refundRef,
      originalTxnId: txn_id,
      amount: Number(amount_minor || 0),
      message: 'UPI Refund Processed'
    });
  }
}

