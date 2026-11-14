# Part C Change Log: File-Level Edits & Architectural Enhancements

**Date:** 2026-11-14  
**Scope:** Part C (Case Studies C1–C5, C6 Bonus)  
**Author:** ZeTheta Architecture Team  

---

## 1. Schema Migrations

### `src/database/migrations/20261108000009_create_payment_retry_and_settlement_tables.ts`
- **Purpose:** Adds database persistence structures required for Case Studies C1 and C2.
- **Changes:**
  1. Created `payment_retry_queue`: Durable table for asynchronous checkout retries with columns `(id, transaction_id, attempt_id, action, retry_count, max_retries, next_retry_at, lease_expires_at, status, error_message, payload, created_at, updated_at)`.
  2. Created partial index `idx_payment_retry_queue_pending` on `(status, next_retry_at)` where status in `('PENDING', 'FAILED')`.
  3. Created `settlement_batches`: Table tracking settlement files from gateways with `(batch_reference, gateway, total_transactions, total_amount_minor, currency, status)`.
  4. Extended `transactions` table with `settlement_batch_id UUID` and `settlement_status VARCHAR(50) DEFAULT 'PENDING'`.

---

## 2. Core Modules Created

### `src/modules/payments/retry.service.ts`
- **Purpose:** Implements persistent asynchronous retry queue processing and exponential backoff with randomized jitter (C1).
- **Key Functions:**
  - `calculateBackoffWithJitter(attempt, baseMs, capMs, jitterFraction)`: Calculates randomized backoff adhering to 1s, 2s, 4s bounds.
  - `PaymentRetryService.enqueueRetry()`: Persists retry tasks to `payment_retry_queue`.
  - `PaymentRetryService.processNextRetryJob()`: Worker method using PostgreSQL `FOR UPDATE SKIP LOCKED` to safely claim and process retries without worker collision or duplicate downstream charges.

### `src/modules/fulfilment/fulfilment-gate.service.ts`
- **Purpose:** Implements strict order fulfilment gating invariant (C3).
- **Key Functions:**
  - `FulfilmentGateService.canFulfil(transactionId)`: Evaluates transaction state. Returns `allowed: true` only if state is `CAPTURED` or `SETTLED`. Rejects all pending states (`AUTH_INITIATED`, `AUTHORISED`, `AUTH_EXPIRED`).
  - `FulfilmentGateService.triggerFulfilment(transactionId)`: Emits `fulfilment.allowed` event idempotently upon confirmed capture.

---

## 3. Core Modules Enhanced

### `src/modules/webhooks/webhook.service.ts`
- **Purpose:** Enhanced semantic payload validation and lifecycle event coverage (C2, C4).
- **Changes:**
  - **C4 Protection:** Added amount-minor and currency verification against the locked `transactions` record. Even with valid HMAC signatures, webhooks for mismatched amounts (e.g. ₹10 applied to ₹50,000 order) or mismatched currencies are rejected with `WEBHOOK_AMOUNT_MISMATCH` or `WEBHOOK_CURRENCY_MISMATCH` security audit logs.
  - **PayU Currency Formatting:** Automatically parses major decimal currency strings (`'350.00'`) to integer minor units (`35000`).
  - **C2 Protection:** Added handling for `dispute.created`, `payment.reversed`, and `payment.failed`. Dispute webhooks create open high-severity anomaly records in `reconciliation_anomalies` with `auto_refund_blocked: true`.
  - **C3 Integration:** Connected `FulfilmentGateService.triggerFulfilment()` upon successful capture transition.

### `src/api/middleware/error.middleware.ts`
- **Purpose:** Fail-fast HTTP 503 error boundary under connection pool exhaustion (C5).
- **Changes:**
  - Intercepts PostgreSQL connection timeout (`53300`, `timeout exceeded when trying to connect`, or `pool exhausted`).
  - Returns `503 Service Unavailable` with `Retry-After: 5` header without attempting database error logging.

### `src/modules/reconciliation/reconciliation.service.ts`
- **Purpose:** Settlement batch inclusion tracking (C2).
- **Changes:**
  - Updates `transactions.settlement_status = 'SETTLED'` when transaction matches gateway settlement file.
  - Updates `transactions.settlement_status = 'DISCREPANCY'` when internally captured transaction is missing from settlement file.

---

## 4. Test Suites Created

- `tests/case-studies/C1-double-charge-prevention.test.ts` (5 tests)
- `tests/case-studies/C2-settlement-reconciliation.test.ts` (3 tests)
- `tests/case-studies/C3-upi-fulfilment-gate.test.ts` (3 tests)
- `tests/case-studies/C4-webhook-replay-fraud.test.ts` (3 tests)
- `tests/case-studies/C5-connection-pool-stampede.test.ts` (2 tests)

---

## 5. Security & Financial Implications
- **Zero Double-Charges:** Concurrent retries and worker re-deliveries cannot produce secondary charges.
- **Replay Fraud Defeated:** Signature-valid low-value webhooks cannot mark high-value orders paid.
- **Audit Immutability Preserved:** No illegal state mutations (`CAPTURED` never transitions to `FAILED`).
- **No Unauthorized Auto-Refunds:** Settlement discrepancies and dispute callbacks flag investigation anomalies instead of automatically draining merchant balances.

