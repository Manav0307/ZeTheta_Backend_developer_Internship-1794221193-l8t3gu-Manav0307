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

export class UpiAdapter implements PaymentGateway {
  readonly name = 'upi' as const;

  readonly capabilities: GatewayCapabilities = {
    supportsCard: false,
    supportsUpi: true,
    supportsNetbanking: false,
    supportsTwoPhase: false, // Instant settlement
    supportsPartialCapture: false,
    supportsPartialRefund: false,
    supportedCurrencies: ['INR']
  };

  async authorize(input: AuthorizationInput): Promise<GatewayOutcome> {
    const behavior = MockGatewayController.getBehavior(this.name);
    const providerRef = `upi_${crypto.randomBytes(8).toString('hex')}`;
    const orderRef = `upitxn_${crypto.randomBytes(6).toString('hex')}`;

    if (behavior === 'hard_decline') {
      return {
        status: 'HARD_DECLINE',
        errorCode: 'UPI_PSP_DECLINED',
        errorMessage: 'UPI transaction declined by customer PSP or bank',
        durationMs: 100
      };
    }

    if (behavior === 'definite_5xx') {
      return {
        status: 'TRANSIENT_FAILURE',
        errorCode: 'UPI_SWITCH_ERROR',
        errorMessage: 'UPI Switch/NPCI aggregator down (500)',
        durationMs: 70
      };
    }

    if (behavior === 'rate_limited') {
      return {
        status: 'RATE_LIMITED',
        errorCode: 'RATE_LIMIT_EXCEEDED',
        errorMessage: 'UPI aggregator rate limit exceeded (429)',
        durationMs: 40
      };
    }

    if (behavior === 'timeout_before_execution') {
      return {
        status: 'TRANSIENT_FAILURE',
        errorCode: 'TIMEOUT_PRE_EXECUTION',
        errorMessage: 'Timeout contacting UPI PSP',
        durationMs: 500
      };
    }

    if (behavior === 'timeout_after_execution') {
      MockGatewayController.recordCharge(providerRef, 'CAPTURED', input.amountMinor, this.name);
      return {
        status: 'TIMEOUT_UNKNOWN',
        providerPaymentRef: providerRef,
        errorCode: 'TIMEOUT',
        errorMessage: 'Timeout waiting for UPI customer authorization callback',
        durationMs: 2000
      };
    }

    // UPI is instant capture
    MockGatewayController.recordCharge(providerRef, 'CAPTURED', input.amountMinor, this.name);

    return {
      status: 'CAPTURED',
      providerPaymentRef: providerRef,
      providerOrderRef: orderRef,
      rawResponse: {
        txnId: providerRef,
        rrn: crypto.randomBytes(6).toString('hex'),
        responseCode: '00',
        status: 'SUCCESS'
      },
      durationMs: 90
    };
  }

  async capture(input: CaptureInput): Promise<GatewayOutcome> {
    // UPI already captured at payment time
    return {
      status: 'CAPTURED',
      providerPaymentRef: input.providerPaymentRef,
      rawResponse: { status: 'already_captured' },
      durationMs: 30
    };
  }

  async void(input: VoidInput): Promise<GatewayOutcome> {
    return {
      status: 'TRANSIENT_FAILURE',
      errorCode: 'UNSUPPORTED_OPERATION',
      errorMessage: 'UPI does not support void operations after instant capture',
      durationMs: 30
    };
  }

  async refund(input: RefundInput): Promise<GatewayOutcome> {
    const behavior = MockGatewayController.getBehavior(this.name);
    if (behavior === 'refund_failure') {
      return {
        status: 'TRANSIENT_FAILURE',
        errorCode: 'UPI_REFUND_DECLINED',
        errorMessage: 'UPI bank declined refund',
        durationMs: 90
      };
    }

    const refundRef = `upirfnd_${crypto.randomBytes(8).toString('hex')}`;
    return {
      status: 'REFUNDED',
      providerPaymentRef: refundRef,
      rawResponse: {
        refundId: refundRef,
        originalTxnId: input.providerPaymentRef,
        status: 'SUCCESS'
      },
      durationMs: 80
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
      status: 'CAPTURED',
      providerPaymentRef: input.providerPaymentRef,
      rawResponse: { status: 'captured' }
    };
  }

  verifyWebhook(
    rawBody: Buffer,
    headers: Record<string, unknown>,
    secret: string = 'mock-upi-secret'
  ): VerifiedGatewayEvent {
    const signature = (headers['x-upi-signature'] || headers['x-signature'] || '') as string;
    if (!signature) {
      return { isValid: false, eventId: '', eventType: '', payload: {}, error: 'Missing x-upi-signature header' };
    }

    try {
      const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
      const sigBuf = Buffer.from(signature, 'utf8');
      const expBuf = Buffer.from(expected, 'utf8');

      if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
        return { isValid: false, eventId: '', eventType: '', payload: {}, error: 'UPI signature mismatch' };
      }

      const payload = JSON.parse(rawBody.toString('utf8'));
      const eventId = payload.eventId || payload.txnId || `evt_${crypto.randomBytes(6).toString('hex')}`;
      const eventType = payload.eventType || 'upi.payment.success';

      return {
        isValid: true,
        eventId,
        eventType,
        providerPaymentRef: payload.txnId,
        providerOrderRef: payload.orderId,
        status: payload.status,
        amountMinor: payload.amountMinor ? String(payload.amountMinor) : undefined,
        payload
      };
    } catch (err: any) {
      return { isValid: false, eventId: '', eventType: '', payload: {}, error: err.message };
    }
  }
}

