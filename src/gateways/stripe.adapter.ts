import crypto from 'crypto';
import {
  PaymentGateway,
  GatewayCapabilities,
  AuthorizationInput,
  CaptureInput,
  VoidInput,
  RefundInput,
  GatewayOutcome,
  GatewayStatusQuery,
  GatewayStatus,
  VerifiedGatewayEvent
} from './gateway.interface.js';
import { MockGatewayController } from './mocks/index.js';

export class StripeAdapter implements PaymentGateway {
  readonly name = 'stripe' as const;

  readonly capabilities: GatewayCapabilities = {
    supportsCard: true,
    supportsUpi: false,
    supportsNetbanking: false,
    supportsTwoPhase: true,
    supportsPartialCapture: true,
    supportsPartialRefund: true,
    supportedCurrencies: ['INR', 'USD', 'EUR']
  };

  async authorize(input: AuthorizationInput): Promise<GatewayOutcome> {
    const behavior = MockGatewayController.getBehavior(this.name);
    const providerRef = `pi_${crypto.randomBytes(12).toString('hex')}`;

    if (behavior === 'hard_decline') {
      return {
        status: 'HARD_DECLINE',
        errorCode: 'CARD_DECLINED',
        errorMessage: 'Your card was declined by the issuer.',
        durationMs: 140
      };
    }

    if (behavior === 'definite_5xx') {
      return {
        status: 'TRANSIENT_FAILURE',
        errorCode: 'API_CONNECTION_ERROR',
        errorMessage: 'Stripe internal server error (500)',
        durationMs: 90
      };
    }

    if (behavior === 'rate_limited') {
      return {
        status: 'RATE_LIMITED',
        errorCode: 'RATE_LIMIT_EXCEEDED',
        errorMessage: 'Too many requests to Stripe API (429)',
        durationMs: 40
      };
    }

    if (behavior === 'timeout_before_execution') {
      return {
        status: 'TRANSIENT_FAILURE',
        errorCode: 'TIMEOUT_PRE_EXECUTION',
        errorMessage: 'Socket timeout before dispatch',
        durationMs: 500
      };
    }

    if (behavior === 'timeout_after_execution') {
      MockGatewayController.recordCharge(providerRef, 'AUTHORISED', input.amountMinor, this.name);
      return {
        status: 'TIMEOUT_UNKNOWN',
        providerPaymentRef: providerRef,
        errorCode: 'TIMEOUT',
        errorMessage: 'Connection timed out while waiting for Stripe confirmation',
        durationMs: 2000
      };
    }

    const finalStatus = input.captureMode === 'AUTOMATIC' ? 'CAPTURED' : 'AUTHORISED';
    MockGatewayController.recordCharge(providerRef, finalStatus, input.amountMinor, this.name);

    return {
      status: finalStatus,
      providerPaymentRef: providerRef,
      rawResponse: {
        id: providerRef,
        object: 'payment_intent',
        amount: parseInt(input.amountMinor, 10),
        currency: input.currency.toLowerCase(),
        status: finalStatus === 'CAPTURED' ? 'succeeded' : 'requires_capture'
      },
      durationMs: 130
    };
  }

  async capture(input: CaptureInput): Promise<GatewayOutcome> {
    const behavior = MockGatewayController.getBehavior(this.name);
    if (behavior === 'capture_failure') {
      return {
        status: 'TRANSIENT_FAILURE',
        errorCode: 'CAPTURE_FAILED',
        errorMessage: 'Payment intent capture failed',
        durationMs: 110
      };
    }

    MockGatewayController.recordCharge(input.providerPaymentRef, 'CAPTURED', input.amountMinor, this.name);
    return {
      status: 'CAPTURED',
      providerPaymentRef: input.providerPaymentRef,
      rawResponse: {
        id: input.providerPaymentRef,
        status: 'succeeded',
        amount_received: parseInt(input.amountMinor, 10)
      },
      durationMs: 120
    };
  }

  async void(input: VoidInput): Promise<GatewayOutcome> {
    MockGatewayController.recordCharge(input.providerPaymentRef, 'VOIDED', '0', this.name);
    return {
      status: 'VOIDED',
      providerPaymentRef: input.providerPaymentRef,
      rawResponse: { id: input.providerPaymentRef, status: 'canceled' },
      durationMs: 95
    };
  }

  async refund(input: RefundInput): Promise<GatewayOutcome> {
    const behavior = MockGatewayController.getBehavior(this.name);
    if (behavior === 'refund_failure') {
      return {
        status: 'TRANSIENT_FAILURE',
        errorCode: 'REFUND_FAILED',
        errorMessage: 'Stripe refund processing failed',
        durationMs: 110
      };
    }

    const refundRef = `re_${crypto.randomBytes(12).toString('hex')}`;
    return {
      status: 'REFUNDED',
      providerPaymentRef: refundRef,
      rawResponse: {
        id: refundRef,
        payment_intent: input.providerPaymentRef,
        amount: parseInt(input.amountMinor, 10),
        status: 'succeeded'
      },
      durationMs: 125
    };
  }

  async fetchPaymentStatus(input: GatewayStatusQuery): Promise<GatewayStatus> {
    if (!input.providerPaymentRef) {
      return { status: 'UNKNOWN' };
    }
    const charge = MockGatewayController.getCharge(input.providerPaymentRef);
    if (charge) {
      return {
        status: charge.status as any,
        providerPaymentRef: input.providerPaymentRef,
        amountMinor: charge.amountMinor,
        rawResponse: { status: charge.status }
      };
    }
    return {
      status: 'AUTHORISED',
      providerPaymentRef: input.providerPaymentRef,
      rawResponse: { status: 'requires_capture' }
    };
  }

  verifyWebhook(
    rawBody: Buffer,
    headers: Record<string, unknown>,
    secret: string = 'mock-stripe-secret'
  ): VerifiedGatewayEvent {
    const signatureHeader = (headers['stripe-signature'] || '') as string;
    if (!signatureHeader) {
      return { isValid: false, eventId: '', eventType: '', payload: {}, error: 'Missing stripe-signature header' };
    }

    try {
      const items = signatureHeader.split(',');
      let timestamp = '';
      let signature = '';

      for (const item of items) {
        const [k, v] = item.split('=');
        if (k.trim() === 't') timestamp = v.trim();
        if (k.trim() === 'v1') signature = v.trim();
      }

      if (!timestamp || !signature) {
        return { isValid: false, eventId: '', eventType: '', payload: {}, error: 'Malformed stripe-signature header' };
      }

      // Check timestamp freshness (within 5 minutes = 300s)
      const nowSeconds = Math.floor(Date.now() / 1000);
      const eventSeconds = parseInt(timestamp, 10);
      if (Math.abs(nowSeconds - eventSeconds) > 300) {
        return { isValid: false, eventId: '', eventType: '', payload: {}, error: 'Webhook timestamp outside tolerance window' };
      }

      const signedPayload = `${timestamp}.${rawBody.toString('utf8')}`;
      const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');

      const sigBuf = Buffer.from(signature, 'utf8');
      const expBuf = Buffer.from(expected, 'utf8');

      if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
        return { isValid: false, eventId: '', eventType: '', payload: {}, error: 'Stripe signature mismatch' };
      }

      const payload = JSON.parse(rawBody.toString('utf8'));
      const eventId = payload.id || `evt_${crypto.randomBytes(8).toString('hex')}`;
      const eventType = payload.type || 'payment_intent.amount_capturable_updated';
      const obj = payload.data?.object || {};

      return {
        isValid: true,
        eventId,
        eventType,
        providerPaymentRef: obj.id,
        status: obj.status,
        amountMinor: obj.amount ? String(obj.amount) : undefined,
        payload
      };
    } catch (err: any) {
      return { isValid: false, eventId: '', eventType: '', payload: {}, error: err.message };
    }
  }
}

