export interface GatewayCapabilities {
  supportsCard: boolean;
  supportsUpi: boolean;
  supportsNetbanking: boolean;
  supportsTwoPhase: boolean;
  supportsPartialCapture: boolean;
  supportsPartialRefund: boolean;
  supportedCurrencies: string[];
}

export type GatewayOutcomeStatus =
  | 'AUTHORISED'
  | 'CAPTURED'
  | 'HARD_DECLINE'
  | 'TRANSIENT_FAILURE'
  | 'RATE_LIMITED'
  | 'TIMEOUT_UNKNOWN'
  | 'VOIDED'
  | 'REFUNDED';

export interface GatewayOutcome {
  status: GatewayOutcomeStatus;
  providerPaymentRef?: string;
  providerOrderRef?: string;
  errorCode?: string;
  errorMessage?: string;
  rawResponse?: Record<string, any>;
  durationMs?: number;
}

export interface AuthorizationInput {
  transactionId: string;
  attemptId: string;
  amountMinor: string;
  currency: string;
  paymentMethod: string;
  captureMode: string;
  traceId: string;
  idempotencyKey?: string;
  metadata?: Record<string, any>;
}

export interface CaptureInput {
  transactionId: string;
  attemptId: string;
  providerPaymentRef: string;
  amountMinor: string;
  traceId: string;
  idempotencyKey?: string;
}

export interface VoidInput {
  transactionId: string;
  attemptId: string;
  providerPaymentRef: string;
  traceId: string;
}

export interface RefundInput {
  transactionId: string;
  attemptId: string;
  providerPaymentRef: string;
  amountMinor: string;
  currency: string;
  traceId: string;
  reason?: string;
  idempotencyKey?: string;
}

export interface GatewayStatusQuery {
  transactionId: string;
  attemptId: string;
  providerPaymentRef?: string;
  providerOrderRef?: string;
  traceId: string;
}

export interface GatewayStatus {
  status: 'AUTHORISED' | 'CAPTURED' | 'FAILED' | 'VOIDED' | 'REFUNDED' | 'UNKNOWN';
  providerPaymentRef?: string;
  amountMinor?: string;
  rawResponse?: Record<string, any>;
}

export interface VerifiedGatewayEvent {
  isValid: boolean;
  eventId: string;
  eventType: string;
  providerPaymentRef?: string;
  providerOrderRef?: string;
  status?: string;
  amountMinor?: string;
  payload: Record<string, any>;
  error?: string;
}

export interface PaymentGateway {
  readonly name: 'razorpay' | 'stripe' | 'payu' | 'upi';
  readonly capabilities: GatewayCapabilities;
  authorize(input: AuthorizationInput): Promise<GatewayOutcome>;
  capture(input: CaptureInput): Promise<GatewayOutcome>;
  void(input: VoidInput): Promise<GatewayOutcome>;
  refund(input: RefundInput): Promise<GatewayOutcome>;
  fetchPaymentStatus(input: GatewayStatusQuery): Promise<GatewayStatus>;
  verifyWebhook(rawBody: Buffer, headers: Record<string, unknown>, secret?: string): VerifiedGatewayEvent;
}

