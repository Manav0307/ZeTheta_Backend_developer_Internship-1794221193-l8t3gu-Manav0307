import { TransactionState } from '../../shared/types/index.js';
import { InvalidStateTransitionException } from '../../shared/errors/index.js';

export interface TransitionRule {
  from: TransactionState;
  to: TransactionState;
  event: string;
}

export const VALID_TRANSITIONS: TransitionRule[] = [
  { from: 'CREATED', to: 'ROUTE_SELECTED', event: 'ROUTE_SELECT' },
  { from: 'CREATED', to: 'ABANDONED', event: 'ABANDON' },
  { from: 'ROUTE_SELECTED', to: 'AUTH_INITIATED', event: 'BEGIN_AUTH' },
  { from: 'ROUTE_SELECTED', to: 'ROUTE_FAILED', event: 'ROUTE_EXHAUSTED' },
  { from: 'AUTH_INITIATED', to: 'AUTHORISED', event: 'AUTH_SUCCESS' },
  { from: 'AUTH_INITIATED', to: 'CAPTURED', event: 'CAPTURE_COMPLETE' },
  { from: 'AUTH_INITIATED', to: 'AUTH_FAILED', event: 'AUTH_DECLINE' },
  { from: 'AUTH_INITIATED', to: 'AUTH_TIMEOUT', event: 'AUTH_TIMEOUT' },
  { from: 'AUTH_INITIATED', to: 'AUTH_EXPIRED', event: 'AUTH_EXPIRED' },
  { from: 'AUTH_INITIATED', to: 'AUTH_EXPIRED', event: 'MANDATE_EXPIRED' },
  { from: 'AUTH_FAILED', to: 'ROUTE_SELECTED', event: 'SAFE_REROUTE' },
  { from: 'AUTH_FAILED', to: 'FAILED', event: 'TERMINAL_FAIL' },
  { from: 'AUTH_TIMEOUT', to: 'AUTHORISED', event: 'RECONCILED_SUCCESS' },
  { from: 'AUTH_TIMEOUT', to: 'AUTH_FAILED', event: 'RECONCILED_FAILURE' },
  { from: 'AUTH_TIMEOUT', to: 'ROUTE_SELECTED', event: 'VERIFIED_SAFE_REROUTE' },
  { from: 'AUTHORISED', to: 'CAPTURE_INITIATED', event: 'BEGIN_CAPTURE' },
  { from: 'AUTHORISED', to: 'CAPTURED', event: 'CAPTURE_COMPLETE' },
  { from: 'AUTHORISED', to: 'VOID_INITIATED', event: 'BEGIN_VOID' },
  { from: 'AUTHORISED', to: 'AUTH_EXPIRED', event: 'HOLD_EXPIRED' },
  { from: 'CAPTURE_INITIATED', to: 'CAPTURED', event: 'CAPTURE_COMPLETE' },
  { from: 'CAPTURE_INITIATED', to: 'PARTIALLY_CAPTURED', event: 'CAPTURE_PARTIAL' },
  { from: 'CAPTURE_INITIATED', to: 'CAPTURE_FAILED', event: 'CAPTURE_ERROR' },
  { from: 'PARTIALLY_CAPTURED', to: 'CAPTURE_INITIATED', event: 'CAPTURE_REMAINDER' },
  { from: 'PARTIALLY_CAPTURED', to: 'VOID_INITIATED', event: 'BEGIN_VOID' },
  { from: 'PARTIALLY_CAPTURED', to: 'CAPTURED', event: 'RELEASE_REMAINDER' },
  { from: 'PARTIALLY_CAPTURED', to: 'REFUND_INITIATED', event: 'BEGIN_REFUND' },
  { from: 'PARTIALLY_CAPTURED', to: 'SETTLED', event: 'SETTLEMENT_CONFIRMED' },
  { from: 'CAPTURE_FAILED', to: 'CAPTURE_INITIATED', event: 'RETRY_SAFE_CAPTURE' },
  { from: 'CAPTURE_FAILED', to: 'VOID_INITIATED', event: 'BEGIN_VOID' },
  { from: 'CAPTURED', to: 'REFUND_INITIATED', event: 'BEGIN_REFUND' },
  { from: 'CAPTURED', to: 'SETTLED', event: 'SETTLEMENT_CONFIRMED' },
  { from: 'SETTLED', to: 'REFUND_INITIATED', event: 'BEGIN_REFUND' },
  { from: 'REFUND_INITIATED', to: 'PARTIALLY_REFUNDED', event: 'PARTIAL_REFUND_DONE' },
  { from: 'REFUND_INITIATED', to: 'REFUNDED', event: 'FULL_REFUND_DONE' },
  { from: 'REFUND_INITIATED', to: 'REFUND_FAILED', event: 'REFUND_ERROR' },
  { from: 'PARTIALLY_REFUNDED', to: 'REFUND_INITIATED', event: 'ADDITIONAL_REFUND' },
  { from: 'REFUND_FAILED', to: 'REFUND_INITIATED', event: 'RETRY_SAFE_REFUND' },
  { from: 'VOID_INITIATED', to: 'VOIDED', event: 'VOID_SUCCESS' }
];

export function isValidTransition(from: TransactionState, to: TransactionState): boolean {
  if (from === to) return true;
  return VALID_TRANSITIONS.some((t) => t.from === from && t.to === to);
}

export function getAllowedTransitions(from: TransactionState): TransactionState[] {
  const allowed = new Set<TransactionState>();
  for (const t of VALID_TRANSITIONS) {
    if (t.from === from) {
      allowed.add(t.to);
    }
  }
  return Array.from(allowed);
}

export function assertValidTransition(
  from: TransactionState,
  to: TransactionState,
  event: string
): void {
  if (!isValidTransition(from, to)) {
    const allowed = getAllowedTransitions(from);
    throw new InvalidStateTransitionException(from, to, allowed, { event });
  }
}


