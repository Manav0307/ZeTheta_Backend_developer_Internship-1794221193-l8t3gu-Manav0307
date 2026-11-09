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
import { MockStateStore } from '../modules/gateway-mocks/mock-state.store.js';


export class PayUAdapter implements PaymentGateway {
  readonly name = 'payu' as const;

  readonly capabilities: GatewayCapabilities = {
    supportsCard: true,
    supportsUpi: true,
    supportsNetbanking: true,
    supportsTwoPhase: true,
    supportsPartialCapture: false,
    supportsPartialRefund: true,
    supportedCurrencies: ['INR']
  };

  async authorize(input: AuthorizationInput): Promise<GatewayOutcome> {
    const behavior = MockGatewayController.getBehavior(this.name);
    const providerRef = `payu_${crypto.randomBytes(8).toString('hex')}`;
    const orderRef = `txnid_${crypto.randomBytes(6).toString('hex')}`;

    if (behavior === 'hard_decline') {
      return {
        status: 'HARD_DECLINE',
        errorCode: 'E001_DECLINED',
        errorMessage: 'Transaction declined by issuing bank',
        durationMs: 160
      };
    }

    if (behavior === 'definite_5xx') {
      return {
        status: 'TRANSIENT_FAILURE',
        errorCode: 'PAYU_GATEWAY_ERROR',
        errorMessage: 'PayU bank switch unavailable (500)',
        durationMs: 90
      };
    }

    if (behavior === 'rate_limited') {
      return {
        status: 'RATE_LIMITED',
        errorCode: 'THROTTLED',
        errorMessage: 'Rate limit exceeded for PayU merchant account',
        durationMs: 40
      };
    }

    if (behavior === 'timeout_before_execution') {
      return {
        status: 'TRANSIENT_FAILURE',
        errorCode: 'CONNECT_TIMEOUT',
        errorMessage: 'Connection timeout connecting to PayU',
        durationMs: 500
      };
    }

    if (behavior === 'timeout_after_execution') {
      MockGatewayController.recordCharge(providerRef, 'AUTHORISED', input.amountMinor, this.name);
      return {
        status: 'TIMEOUT_UNKNOWN',
        providerPaymentRef: providerRef,
        errorCode: 'READ_TIMEOUT',
        errorMessage: 'Read timeout waiting for PayU auth response',
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
        mihpayid: providerRef,
        txnid: orderRef,
        amount: parseInt(input.amountMinor, 10) / 100,
        status: finalStatus.toLowerCase()
      },
      durationMs: 140
    };
  }

  async capture(input: CaptureInput): Promise<GatewayOutcome> {
    const scenarioFailFirstN = MockStateStore.getScenarioParam<number>('payu_capture_fail_count');
    if (scenarioFailFirstN !== undefined) {
      const currentAttempts = (MockStateStore.getScenarioParam<number>(`payu_capture_attempts_${input.providerPaymentRef}`) || 0) + 1;
      MockStateStore.setScenarioParam(`payu_capture_attempts_${input.providerPaymentRef}`, currentAttempts);
      if (currentAttempts <= scenarioFailFirstN) {
        return {
          status: 'TRANSIENT_FAILURE',
          errorCode: 'BAD_GATEWAY_502',
          errorMessage: 'PayU 502 Bad Gateway',
          durationMs: 120
        };
      }
    }

    const behavior = MockGatewayController.getBehavior(this.name);
    if (behavior === 'capture_failure') {
      return {
        status: 'TRANSIENT_FAILURE',
        errorCode: 'CAPTURE_FAILED',
        errorMessage: 'PayU settlement hold capture failed',
        durationMs: 120
      };
    }

    MockGatewayController.recordCharge(input.providerPaymentRef, 'CAPTURED', input.amountMinor, this.name);
    MockStateStore.updatePaymentStatus(input.providerPaymentRef, 'CAPTURED', input.amountMinor);
    return {
      status: 'CAPTURED',
      providerPaymentRef: input.providerPaymentRef,
      rawResponse: { mihpayid: input.providerPaymentRef, status: 'captured' },
      durationMs: 125
    };
  }


  async void(input: VoidInput): Promise<GatewayOutcome> {
    MockGatewayController.recordCharge(input.providerPaymentRef, 'VOIDED', '0', this.name);
    return {
      status: 'VOIDED',
      providerPaymentRef: input.providerPaymentRef,
      rawResponse: { mihpayid: input.providerPaymentRef, status: 'voided' },
      durationMs: 100
    };
  }

  async refund(input: RefundInput): Promise<GatewayOutcome> {
    const behavior = MockGatewayController.getBehavior(this.name);
    if (behavior === 'refund_failure') {
      return {
        status: 'TRANSIENT_FAILURE',
        errorCode: 'REFUND_FAILED',
        errorMessage: 'PayU refund request failed',
        durationMs: 110
      };
    }

    const refundRef = `payu_rfnd_${crypto.randomBytes(8).toString('hex')}`;
    return {
      status: 'REFUNDED',
      providerPaymentRef: refundRef,
      rawResponse: {
        refund_id: refundRef,
        mihpayid: input.providerPaymentRef,
        status: 'success'
      },
      durationMs: 130
    };
  }

  async fetchPaymentStatus(input: GatewayStatusQuery): Promise<GatewayStatus> {
    if (!input.providerPaymentRef) {
      return { status: 'UNKNOWN' };
    }
    const forcedStatus = MockStateStore.getScenarioParam<string>(`status_${input.providerPaymentRef}`);
    if (forcedStatus) {
      return {
        status: forcedStatus as any,
        providerPaymentRef: input.providerPaymentRef,
        rawResponse: { status: forcedStatus }
      };
    }
    const charge = MockGatewayController.getCharge(input.providerPaymentRef);
    const mockPayment = MockStateStore.getPayment(input.providerPaymentRef);
    if (charge || mockPayment) {
      const status = (charge?.status || mockPayment?.status || 'UNKNOWN') as any;
      return {
        status,
        providerPaymentRef: input.providerPaymentRef,
        amountMinor: charge?.amountMinor || mockPayment?.amountMinor,
        rawResponse: { status }
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
    secret: string = 'mock-payu-secret'
  ): VerifiedGatewayEvent {
    const signature = (headers['x-payu-signature'] || '') as string;
    if (!signature) {
      return { isValid: false, eventId: '', eventType: '', payload: {}, error: 'Missing x-payu-signature header' };
    }

    try {
      // PayU uses SHA-512 HMAC
      const expected = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
      const sigBuf = Buffer.from(signature, 'utf8');
      const expBuf = Buffer.from(expected, 'utf8');

      if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
        return { isValid: false, eventId: '', eventType: '', payload: {}, error: 'PayU signature mismatch' };
      }

      const payload = JSON.parse(rawBody.toString('utf8'));
      const eventId = payload.event_id || payload.mihpayid || `evt_${crypto.randomBytes(6).toString('hex')}`;
      const eventType = payload.status === 'success' ? 'payment.captured' : 'payment.authorized';

      return {
        isValid: true,
        eventId,
        eventType,
        providerPaymentRef: payload.mihpayid,
        providerOrderRef: payload.txnid,
        status: payload.status,
        amountMinor: payload.amount ? String(Math.round(Number(payload.amount) * 100)) : undefined,
        payload
      };
    } catch (err: any) {
      return { isValid: false, eventId: '', eventType: '', payload: {}, error: err.message };
    }
  }
}

