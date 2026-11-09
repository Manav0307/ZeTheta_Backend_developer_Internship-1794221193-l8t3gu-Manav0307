# Part B Financial & State Machine Integrity Audit

**Executed At:** 2026-11-09T10:12:37.518Z  
**Audit Outcome:** ✅ 10/10 Invariants Satisfied (Zero Violations)  

| Check ID | Invariant Description | Status | Violations |
|---|---|---|---|
| `Q01` | **Zero Orphan Payment Attempts**: Every payment attempt must reference an existing transaction. | ✅ PASS | 0 |
| `Q02` | **Financial Arithmetic Invariants**: captured <= authorized AND (refunded + reserved) <= captured. | ✅ PASS | 0 |
| `Q03` | **Audit Ledger Trigger Active**: Trigger trg_state_log_immutable must be enabled on transaction_state_log. | ✅ PASS | 0 |
| `Q04` | **Composite Idempotency Uniqueness**: Zero duplicate (merchant_id, operation, key) rows in idempotency_keys. | ✅ PASS | 0 |
| `Q05` | **Single Active Attempt Invariant**: No transaction may have more than one concurrent active attempt. | ✅ PASS | 0 |
| `Q06` | **Legal State Log Transitions**: Zero identical from_state = to_state rows unless explicitly permitted. | ✅ PASS | 0 |
| `Q07` | **No Stale Expired PROCESSING Keys**: Zero idempotency keys in PROCESSING status past expiration. | ✅ PASS | 0 |
| `Q08` | **Webhook Ingestion Deduplication**: Zero duplicate (gateway, event_id) rows in processed_webhook_events. | ✅ PASS | 0 |
| `Q09` | **Zero Negative Monetary Values**: All monetary fields must be non-negative integers. | ✅ PASS | 0 |
| `Q10` | **Captures and Refunds Foreign Key Consistency**: Zero dangling capture or refund records. | ✅ PASS | 0 |

## SQL Invariant Definitions

### Q01: Zero Orphan Payment Attempts
```sql
SELECT pa.id, pa.transaction_id
        FROM payment_attempts pa
        LEFT JOIN transactions t ON pa.transaction_id = t.id
        WHERE t.id IS NULL;
```

### Q02: Financial Arithmetic Invariants
```sql
SELECT id, authorized_minor, captured_minor, refunded_minor, reserved_refund_minor
        FROM transactions
        WHERE captured_minor > authorized_minor 
           OR (refunded_minor + reserved_refund_minor) > captured_minor;
```

### Q03: Audit Ledger Trigger Active
```sql
SELECT tgname, relname, tgenabled
        FROM pg_trigger tg
        JOIN pg_class cl ON tg.tgrelid = cl.oid
        WHERE cl.relname = 'transaction_state_log' 
          AND tg.tgname = 'trg_state_log_immutable';
```

### Q04: Composite Idempotency Uniqueness
```sql
SELECT merchant_id, operation, key, COUNT(*) as cnt
        FROM idempotency_keys
        GROUP BY merchant_id, operation, key
        HAVING COUNT(*) > 1;
```

### Q05: Single Active Attempt Invariant
```sql
SELECT transaction_id, COUNT(*) as active_cnt
        FROM payment_attempts
        WHERE status IN ('CREATED', 'SENT', 'UNKNOWN')
        GROUP BY transaction_id
        HAVING COUNT(*) > 1;
```

### Q06: Legal State Log Transitions
```sql
SELECT id, transaction_id, from_state, to_state, event
        FROM transaction_state_log
        WHERE event NOT IN ('REJECTED_TRANSITION', 'OUT_OF_ORDER_RESOLUTION', 'SETTLEMENT_INVESTIGATION_LOGGED')
          AND from_state = to_state
          AND from_state IS NOT NULL;
```

### Q07: No Stale Expired PROCESSING Keys
```sql
SELECT merchant_id, operation, key
        FROM idempotency_keys
        WHERE status = 'PROCESSING' AND expires_at < NOW();
```

### Q08: Webhook Ingestion Deduplication
```sql
SELECT gateway, event_id, COUNT(*) as cnt
        FROM processed_webhook_events
        GROUP BY gateway, event_id
        HAVING COUNT(*) > 1;
```

### Q09: Zero Negative Monetary Values
```sql
SELECT id, amount_minor, authorized_minor, captured_minor, refunded_minor
        FROM transactions
        WHERE amount_minor < 0 
           OR authorized_minor < 0 
           OR captured_minor < 0 
           OR refunded_minor < 0 
           OR reserved_refund_minor < 0;
```

### Q10: Captures and Refunds Foreign Key Consistency
```sql
SELECT c.id
        FROM capture_operations c
        LEFT JOIN transactions t ON c.transaction_id = t.id
        WHERE t.id IS NULL
        UNION ALL
        SELECT r.id
        FROM refunds r
        LEFT JOIN transactions t ON r.transaction_id = t.id
        WHERE t.id IS NULL;
```

