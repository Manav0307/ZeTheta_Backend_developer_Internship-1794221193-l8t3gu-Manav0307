import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { GatewayRegistry } from '../../src/gateways/registry.js';

describe('Webhook Signature Verification Unit Tests', () => {
  it('verifies valid Razorpay HMAC-SHA256 signature and rejects invalid', () => {
    const razorpay = GatewayRegistry.get('razorpay');
    const secret = 'test-rzp-secret';
    const payload = JSON.stringify({
      id: 'evt_rzp_1',
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_123', status: 'captured', amount: 50000 } } }
    });
    const rawBody = Buffer.from(payload, 'utf8');

    const validSig = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

    const verified = razorpay.verifyWebhook(rawBody, { 'x-razorpay-signature': validSig }, secret);
    expect(verified.isValid).toBe(true);
    expect(verified.providerPaymentRef).toBe('pay_123');

    const tampered = razorpay.verifyWebhook(rawBody, { 'x-razorpay-signature': 'bad-signature' }, secret);
    expect(tampered.isValid).toBe(false);
  });

  it('verifies Stripe timestamped HMAC-SHA256 signature and checks tolerance', () => {
    const stripe = GatewayRegistry.get('stripe');
    const secret = 'test-stripe-secret';
    const payload = JSON.stringify({
      id: 'evt_stripe_1',
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_123', status: 'succeeded', amount: 50000 } }
    });
    const rawBody = Buffer.from(payload, 'utf8');

    const nowSeconds = Math.floor(Date.now() / 1000);
    const signature = crypto.createHmac('sha256', secret).update(`${nowSeconds}.${payload}`).digest('hex');
    const header = `t=${nowSeconds},v1=${signature}`;

    const verified = stripe.verifyWebhook(rawBody, { 'stripe-signature': header }, secret);
    expect(verified.isValid).toBe(true);
    expect(verified.providerPaymentRef).toBe('pi_123');

    // Expired timestamp (e.g. 10 minutes ago > 300s)
    const oldSeconds = nowSeconds - 600;
    const oldSig = crypto.createHmac('sha256', secret).update(`${oldSeconds}.${payload}`).digest('hex');
    const expiredHeader = `t=${oldSeconds},v1=${oldSig}`;

    const expiredCheck = stripe.verifyWebhook(rawBody, { 'stripe-signature': expiredHeader }, secret);
    expect(expiredCheck.isValid).toBe(false);
    expect(expiredCheck.error).toContain('tolerance');
  });

  it('verifies PayU HMAC-SHA512 signature', () => {
    const payu = GatewayRegistry.get('payu');
    const secret = 'test-payu-secret';
    const payload = JSON.stringify({
      mihpayid: 'payu_123',
      status: 'success',
      amount: '500.00'
    });
    const rawBody = Buffer.from(payload, 'utf8');

    const validSig = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
    const verified = payu.verifyWebhook(rawBody, { 'x-payu-signature': validSig }, secret);
    expect(verified.isValid).toBe(true);
    expect(verified.providerPaymentRef).toBe('payu_123');
  });

  it('verifies UPI aggregator HMAC-SHA256 signature', () => {
    const upi = GatewayRegistry.get('upi');
    const secret = 'test-upi-secret';
    const payload = JSON.stringify({
      txnId: 'upi_123',
      status: 'SUCCESS',
      amountMinor: 50000
    });
    const rawBody = Buffer.from(payload, 'utf8');

    const validSig = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    const verified = upi.verifyWebhook(rawBody, { 'x-upi-signature': validSig }, secret);
    expect(verified.isValid).toBe(true);
    expect(verified.providerPaymentRef).toBe('upi_123');
  });
});

