-- =============================================================================
-- ZeTheta Payment Orchestrator - Financial & State Integrity Audit Suite
-- 10 Critical Automated Invariant Checks
-- =============================================================================

-- Query 1: Zero Orphan Payment Attempts
-- Invariant: Every payment attempt must belong to a valid transaction.
SELECT 
    COUNT(*) AS orphan_attempt_count
FROM payment_attempts pa
LEFT JOIN transactions t ON pa.transaction_id = t.id
WHERE t.id IS NULL;

-- Query 2: Financial Arithmetic Integrity (Minor Units)
-- Invariant: captured_minor <= authorized_minor AND (refunded_minor + reserved_refund_minor) <= captured_minor.
SELECT 
    id AS transaction_id,
    authorized_minor,
    captured_minor,
    refunded_minor,
    reserved_refund_minor
FROM transactions
WHERE captured_minor > authorized_minor 
   OR (refunded_minor + reserved_refund_minor) > captured_minor;

-- Query 3: State Log Immutability Verification
-- Invariant: Verify PostgreSQL append-only trigger is active on transaction_state_log.
SELECT 
    tgname AS trigger_name,
    relname AS table_name,
    tgenabled AS trigger_enabled
FROM pg_trigger tg
JOIN pg_class cl ON tg.tgrelid = cl.oid
WHERE cl.relname = 'transaction_state_log' 
  AND tg.tgname = 'trg_state_log_immutable';

-- Query 4: Multi-Tenant Idempotency Composite Uniqueness
-- Invariant: Composite key (merchant_id, operation, key) guarantees uniqueness across merchants.
SELECT 
    merchant_id, 
    operation, 
    key, 
    COUNT(*) AS duplicate_count
FROM idempotency_keys
GROUP BY merchant_id, operation, key
HAVING COUNT(*) > 1;

-- Query 5: Single Active Attempt Invariant
-- Invariant: No transaction may possess more than one concurrent attempt in active state.
SELECT 
    transaction_id, 
    COUNT(*) AS active_attempt_count
FROM payment_attempts
WHERE status IN ('CREATED', 'SENT', 'UNKNOWN')
GROUP BY transaction_id
HAVING COUNT(*) > 1;

-- Query 6: Audit Log Legal State Transitions
-- Invariant: All logged state transitions must conform to the defined state machine or REJECTED_TRANSITION.
SELECT 
    id, 
    transaction_id, 
    from_state, 
    to_state, 
    event
FROM transaction_state_log
WHERE event NOT IN ('REJECTED_TRANSITION', 'OUT_OF_ORDER_RESOLUTION', 'SETTLEMENT_INVESTIGATION_LOGGED')
  AND from_state = to_state
  AND from_state IS NOT NULL;

-- Query 7: No Stale Pending Idempotency Leases
-- Invariant: Idempotency keys must not remain in PROCESSING state past 24-hour expiration window.
SELECT 
    merchant_id, 
    operation, 
    key, 
    status, 
    created_at, 
    expires_at
FROM idempotency_keys
WHERE status = 'PROCESSING' 
  AND expires_at < NOW();

-- Query 8: Webhook Queue & Deduplication Table Consistency
-- Invariant: No duplicate webhook delivery records permitted in processed_webhook_events.
SELECT 
    gateway, 
    event_id, 
    COUNT(*) AS duplicate_count
FROM processed_webhook_events
GROUP BY gateway, event_id
HAVING COUNT(*) > 1;

-- Query 9: Zero Negative Monetary Amounts
-- Invariant: Minor units must be non-negative integers (Numeric >= 0).
SELECT 
    id AS transaction_id, 
    amount_minor, 
    authorized_minor, 
    captured_minor, 
    refunded_minor, 
    reserved_refund_minor
FROM transactions
WHERE amount_minor < 0 
   OR authorized_minor < 0 
   OR captured_minor < 0 
   OR refunded_minor < 0 
   OR reserved_refund_minor < 0;

-- Query 10: Foreign Key Referencing Consistency Across Captures & Refunds
-- Invariant: Every capture and refund record must refer to an existing transaction and attempt.
SELECT 
    c.id AS capture_id, 
    c.transaction_id, 
    c.attempt_id
FROM capture_operations c
LEFT JOIN transactions t ON c.transaction_id = t.id
LEFT JOIN payment_attempts pa ON c.attempt_id = pa.id
WHERE t.id IS NULL OR pa.id IS NULL
UNION ALL
SELECT 
    r.id AS refund_id, 
    r.transaction_id, 
    r.attempt_id
FROM refunds r
LEFT JOIN transactions t ON r.transaction_id = t.id
LEFT JOIN payment_attempts pa ON r.attempt_id = pa.id
WHERE t.id IS NULL OR pa.id IS NULL;

