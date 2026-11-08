export type PaymentMethod = 'CARD' | 'UPI' | 'NETBANKING';
export type CaptureMode = 'MANUAL' | 'AUTOMATIC';

export type TransactionState =
  | 'CREATED'
  | 'ROUTE_SELECTED'
  | 'AUTH_INITIATED'
  | 'AUTHORISED'
  | 'AUTH_FAILED'
  | 'AUTH_TIMEOUT'
  | 'ROUTE_FAILED'
  | 'CAPTURE_INITIATED'
  | 'CAPTURED'
  | 'PARTIALLY_CAPTURED'
  | 'CAPTURE_FAILED'
  | 'REFUND_INITIATED'
  | 'PARTIALLY_REFUNDED'
  | 'REFUND_FAILED'
  | 'REFUNDED'
  | 'FAILED'
  | 'ABANDONED'
  | 'VOID_INITIATED'
  | 'VOIDED'
  | 'AUTH_EXPIRED'
  | 'SETTLED'
  | 'DISPUTE_OPENED'
  | 'DISPUTE_RESOLVED';

export type AttemptStatus =
  | 'CREATED'
  | 'SENT'
  | 'UNKNOWN'
  | 'AUTHORISED'
  | 'CAPTURED'
  | 'FAILED'
  | 'VOIDED';

export type IdempotencyStatus = 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'UNKNOWN';
export type IdempotencyOperation = 'PAYMENT_CREATE' | 'CAPTURE' | 'VOID' | 'REFUND';

export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export type WebhookEventStatus = 'RECEIVED' | 'PROCESSED' | 'DLQ';
export type WebhookQueueStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'DLQ';

export type CaptureOperationStatus = 'PENDING' | 'SENT' | 'UNKNOWN' | 'SUCCEEDED' | 'FAILED';
export type RefundStatus = 'PENDING' | 'SENT' | 'UNKNOWN' | 'SUCCEEDED' | 'FAILED';

export type ReconciliationRunStatus = 'RUNNING' | 'COMPLETED' | 'FAILED';
export type ReconciliationOutcome = 'MATCH' | 'CORRECTED' | 'ANOMALY' | 'ERROR';
export type AnomalySeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type AnomalyStatus = 'OPEN' | 'INVESTIGATING' | 'RESOLVED';

export interface TransactionRecord {
  id: string;
  merchant_id: string;
  merchant_order_id: string;
  payment_method: PaymentMethod;
  currency: string;
  amount_minor: string;
  capture_mode: CaptureMode;
  state: TransactionState;
  authorized_minor: string;
  captured_minor: string;
  refunded_minor: string;
  reserved_refund_minor: string;
  version: string;
  trace_id: string;
  last_error_code: string | null;
  metadata: Record<string, any>;
  created_at: string;
  updated_at: string;
}

export interface PaymentAttemptRecord {
  id: string;
  transaction_id: string;
  gateway: string;
  attempt_no: number;
  status: AttemptStatus;
  provider_payment_ref: string | null;
  provider_order_ref: string | null;
  provider_idempotency_key: string | null;
  amount_minor: string;
  request_dispatched_at: string | null;
  resolved_at: string | null;
  error_class: string | null;
  error_code: string | null;
  trace_id: string;
  created_at: string;
  updated_at: string;
}

export interface TransactionStateLogRecord {
  id: string;
  transaction_id: string;
  attempt_id: string | null;
  from_state: TransactionState | null;
  to_state: TransactionState;
  event: string;
  gateway_reference: string | null;
  gateway_response: Record<string, any>;
  metadata: Record<string, any>;
  trace_id: string;
  created_at: string;
  created_by: string;
}

export interface GatewayConfigRecord {
  gateway_name: string;
  enabled: boolean;
  environment: 'mock' | 'sandbox' | 'live';
  secret_ref: string | null;
  webhook_secret_ref: string | null;
  supports_card: boolean;
  supports_upi: boolean;
  supports_netbanking: boolean;
  supports_two_phase: boolean;
  supports_partial_capture: boolean;
  supports_partial_refund: boolean;
  supported_currencies: string[];
  fee_bps: number;
  fee_fixed_minor: string;
  rate_limit_per_second: number;
  request_timeout_ms: number;
  breaker_failure_threshold: number;
  breaker_cooldown_seconds: number;
  breaker_half_open_max_probes: number;
  created_at: string;
  updated_at: string;
}

export interface RoutingConfigRecord {
  id: number;
  revision: string;
  weight_success: string;
  weight_latency: string;
  weight_cost: string;
  weight_health: string;
  weight_method_fit: string;
  metric_window_minutes: number;
  degraded_preference_threshold: string;
  updated_at: string;
}

export interface GatewayRouteRecord {
  id: string;
  transaction_id: string;
  attempt_id: string | null;
  gateway: string;
  routing_config_revision: string;
  selected: boolean;
  score: string;
  normalized_success: string;
  normalized_latency: string;
  normalized_cost: string;
  health_score: string;
  method_fit_score: string;
  reason: Record<string, any>;
  trace_id: string;
  created_at: string;
}

export interface CircuitBreakerRecord {
  gateway: string;
  payment_method: PaymentMethod;
  state: CircuitBreakerState;
  consecutive_failures: number;
  opened_until: string | null;
  probe_lease_until: string | null;
  probe_owner: string | null;
  updated_at: string;
}

export interface IdempotencyKeyRecord {
  merchant_id: string;
  operation: IdempotencyOperation;
  key: string;
  request_hash: string;
  transaction_id: string | null;
  status: IdempotencyStatus;
  response_code: number | null;
  response_body: Record<string, any> | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

export interface WebhookQueueRecord {
  id: string;
  gateway: string;
  event_id: string;
  transaction_id: string | null;
  attempt_id: string | null;
  payload: Record<string, any>;
  signature_digest: string | null;
  status: WebhookQueueStatus;
  retry_count: number;
  max_retries: number;
  next_retry_at: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
  error_message: string | null;
  trace_id: string | null;
  created_at: string;
  processed_at: string | null;
}

