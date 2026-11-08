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

export class RazorpayAdapter implements PaymentGateway {
  readonly name = 'razorpay' as const;

  readonly capabilities: GatewayCapabilities = {
    supportsCard: true,
    supportsUpi: true,
    supportsNetbanking: true,
    supportsTwoPhase: true,
    supportsPartialCapture: true,
    supportsPartialRefund: true,
    supportedCurrencies: ['INR']
  };

  async authorize(input: AuthorizationInput): Promise<GatewayOutcome> {
    const behavior = MockGatewayController.getBehavior(this.name);
    const providerRef = `pay_rzp_${crypto.randomBytes(8).toString('hex')}`;
    const orderRef = `order_rzp_${crypto.randomBytes(6).toString('hex')}`;

    if (behavior === 'hard_decline') {
      return {
        status: 'HARD_DECLINE',
        errorCode: 'BAD_REQUEST_ERROR',
        errorMessage: 'The card issuer has declined this transaction due to insufficient funds.',
        durationMs: 120
      };
    }

    if (behavior === 'definite_5xx') {
      return {
        status: 'TRANSIENT_FAILURE',
        errorCode: 'GATEWAY_INTERNAL_ERROR',
        errorMessage: 'Razorpay upstream gateway error (500)',
        durationMs: 80
      };
    }

    if (behavior === 'rate_limited') {
      return {
        status: 'RATE_LIMITED',
        errorCode: 'TOO_MANY_REQUESTS',
        errorMessage: 'Razorpay rate limit exceeded (429)',
        durationMs: 40
      };
    }

    if (behavior === 'timeout_before_execution') {
      return {
        status: 'TRANSIENT_FAILURE',
        errorCode: 'NETWORK_TIMEOUT_PRE_EXECUTION',
        errorMessage: 'Connection timeout before dispatching payment',
        durationMs: 500
      };
    }

    if (behavior === 'timeout_after_execution') {
      MockGatewayController.recordCharge(providerRef, 'AUTHORISED', input.amountMinor, this.name);
      return {
        status: 'TIMEOUT_UNKNOWN',
        providerPaymentRef: providerRef,
        errorCode: 'GATEWAY_TIMEOUT',
        errorMessage: 'Gateway timed out; outcome unknown',
        durationMs: 2000
      };
    }

    const finalStatus = input.captureMode === 'AUTOMATIC' ? 'CAPTURED' : 'AUTHORISED';
    MockGatewayController.recordCharge(providerRef, finalStatus, input.amountMinor, this.name);

    return {
      status: finalStatus,
      providerPaymentRef: providerRef,
      providerOrderRef: orderRef,
      rawResponse: {
        id: providerRef,
        entity: 'payment',
        amount: parseInt(input.amountMinor, 10),
        currency: input.currency,
        status: finalStatus.toLowerCase(),
        method: input.paymentMethod.toLowerCase()
      },
      durationMs: 150
    };
  }

  async capture(input: CaptureInput): Promise<GatewayOutcome> {
    const behavior = MockGatewayController.getBehavior(this.name);
    if (behavior === 'capture_failure') {
      return {
        status: 'TRANSIENT_FAILURE',
        errorCode: 'CAPTURE_FAILED',
        errorMessage: 'Failed to capture hold on payment instrument',
        durationMs: 100
      };
    }

    MockGatewayController.recordCharge(input.providerPaymentRef, 'CAPTURED', input.amountMinor, this.name);
    return {
      status: 'CAPTURED',
      providerPaymentRef: input.providerPaymentRef,
      rawResponse: {
        id: input.providerPaymentRef,
        status: 'captured',
        captured_amount: parseInt(input.amountMinor, 10)
      },
      durationMs: 110
    };
  }

  async void(input: VoidInput): Promise<GatewayOutcome> {
    MockGatewayController.recordCharge(input.providerPaymentRef, 'VOIDED', '0', this.name);
    return {
      status: 'VOIDED',
      providerPaymentRef: input.providerPaymentRef,
      rawResponse: { id: input.providerPaymentRef, status: 'voided' },
      durationMs: 90
    };
  }

  async refund(input: RefundInput): Promise<GatewayOutcome> {
    const behavior = MockGatewayController.getBehavior(this.name);
    if (behavior === 'refund_failure') {
      return {
        status: 'TRANSIENT_FAILURE',
        errorCode: 'REFUND_FAILED',
        errorMessage: 'Refund initiation failed',
        durationMs: 120
      };
    }

    const refundRef = `rfnd_rzp_${crypto.randomBytes(8).toString('hex')}`;
    return {
      status: 'REFUNDED',
      providerPaymentRef: refundRef,
      rawResponse: {
        id: refundRef,
        payment_id: input.providerPaymentRef,
        amount: parseInt(input.amountMinor, 10),
        status: 'processed'
      },
      durationMs: 130
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
      rawResponse: { status: 'authorized' }
    };
  }

  verifyWebhook(
    rawBody: Buffer,
    headers: Record<string, unknown>,
    secret: string = 'mock-razorpay-secret'
  ): VerifiedGatewayEvent {
    const signature = (headers['x-razorpay-signature'] || '') as string;
    if (!signature) {
      return { isValid: false, eventId: '', eventType: '', payload: {}, error: 'Missing signature header' };
    }

    try {
      const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
      const sigBuf = Buffer.from(signature, 'utf8');
      const expBuf = Buffer.from(expected, 'utf8');

      if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
        return { isValid: false, eventId: '', eventType: '', payload: {}, error: 'Signature mismatch' };
      }

      const payload = JSON.parse(rawBody.toString('utf8'));
      const eventId = payload.event_id || payload.id || `evt_${crypto.randomBytes(6).toString('hex')}`;
      const eventType = payload.event || 'payment.authorized';
      const paymentEntity = payload.payload?.payment?.entity || {};

      return {
        isValid: true,
        eventId,
        eventType,
        providerPaymentRef: paymentEntity.id,
        providerOrderRef: paymentEntity.order_id,
        status: paymentEntity.status,
        amountMinor: paymentEntity.amount ? String(paymentEntity.amount) : undefined,
        payload
      };
    } catch (err: any) {
      return { isValid: false, eventId: '', eventType: '', payload: {}, error: err.message };
    }
  }
}

