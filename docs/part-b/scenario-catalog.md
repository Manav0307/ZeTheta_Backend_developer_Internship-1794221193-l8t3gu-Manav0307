# Part B Failure Scenario Catalog (FS-01 to FS-15)

This catalog details the verification criteria, trigger conditions, expected invariants, and test files for all 15 Part B simulation scenarios.

---

### FS-01: Gateway Timeout During Authorization
- **Test File:** `tests/part-b/scenarios/FS-01.test.ts`
- **Trigger:** Downstream gateway returns connection/socket timeout or transient 5xx during auth attempt.
- **Expected Behavior:** Circuit breaker failure count increments. On verified 5xx, safe failover routes to secondary gateway (`razorpay`), completing in < 2s. On unconfirmed `TIMEOUT_UNKNOWN`, the platform enforces Invariant #2 (no failover without verified void) and transitions to `AUTH_TIMEOUT`.

### FS-02: Duplicate Webhook Delivery 3x
- **Test File:** `tests/part-b/scenarios/FS-02.test.ts`
- **Trigger:** Gateway delivers identical `payment.captured` webhook 3 times with same event ID.
- **Expected Behavior:** All 3 deliveries return HTTP 200 acknowledged. Exactly 1 state transition (`AUTHORISED -> CAPTURED`) in `transaction_state_log`. Zero duplicate rows in `webhook_queue`.

### FS-03: Double Submit Under High Concurrency
- **Test File:** `tests/part-b/scenarios/FS-03.test.ts`
- **Trigger:** User sends two identical payment requests simultaneously with the same `Idempotency-Key`.
- **Expected Behavior:** Exactly 1 charge executed downstream; second request receives either HTTP 201 with identical payload or 409 Conflict. Exactly 1 transaction in database.

### FS-04: 502 During Capture with Exponential Backoff
- **Test File:** `tests/part-b/scenarios/FS-04.test.ts`
- **Trigger:** PayU capture endpoint returns HTTP 502 Bad Gateway.
- **Expected Behavior:** Orchestrator retries capture with exponential backoff (1s, 2s, 4s). On 3rd attempt success, transitions to `CAPTURED`. If exhausted, polls gateway status before concluding `CAPTURE_FAILED`.

### FS-05: Partial Capture and Remainder Hold Handling
- **Test File:** `tests/part-b/scenarios/FS-05.test.ts`
- **Trigger:** Authorize ₹1200 (`120000` minor), then partially capture ₹800 (`80000` minor).
- **Expected Behavior:** State transitions `AUTHORISED -> CAPTURE_INITIATED -> PARTIALLY_CAPTURED`. Remainder of ₹400 released cleanly via `POST /v1/payments/:id/void-remainder` moving state to `CAPTURED` with `authorized_minor = captured_minor = 80000`.

### FS-06: Early Webhook Arrival Before API Response
- **Test File:** `tests/part-b/scenarios/FS-06.test.ts`
- **Trigger:** Webhook arrives and processes while synchronous API response handler is still executing.
- **Expected Behavior:** Webhook moves state from `AUTH_INITIATED -> CAPTURED`. Late synchronous auth handler resolves race idempotently, does not revert to `AUTHORISED`, and logs `OUT_OF_ORDER_RESOLUTION`.

### FS-07: Cascade Failure Across Gateways & Method-Fit Routing
- **Test File:** `tests/part-b/scenarios/FS-07.test.ts`
- **Trigger:** Razorpay circuit breaker trips OPEN. Card traffic rerouted to PayU/Stripe. Stripe 429 rate-limited.
- **Expected Behavior:** UPI transactions are NEVER routed to Card-only Stripe (Method-Fit preserved). Rate-limited gateways are backed off, and traffic flows exclusively to healthy capable gateways.

### FS-08: Refund on Already-Settled Payment
- **Test File:** `tests/part-b/scenarios/FS-08.test.ts`
- **Trigger:** Payment reaches `SETTLED` state. Merchant initiates refund.
- **Expected Behavior:** State transitions `SETTLED -> REFUND_INITIATED -> REFUNDED`. Financial integrity preserved (`captured_minor = refunded_minor = 100000`).

### FS-09: Multi-Worker Idempotency Race
- **Test File:** `tests/part-b/scenarios/FS-09.test.ts`
- **Trigger:** 5 concurrent processes race on the exact same `Idempotency-Key`.
- **Expected Behavior:** Exactly 1 winner acquires the processing lock and returns HTTP 201; competing requests receive 409 Conflict or cached replay. Exactly 1 transaction created in PostgreSQL.

### FS-10: Webhook Tampering & Signature Verification Failure
- **Test File:** `tests/part-b/scenarios/FS-10.test.ts`
- **Trigger:** Ingest webhook with altered amount (e.g. ₹50 -> ₹50,000) or invalid HMAC signature.
- **Expected Behavior:** Rejected with HTTP 401 `WEBHOOK_SIGNATURE_INVALID`. Payment state completely unchanged in database.

### FS-11: Missing Settlements in Batch Reconciliation
- **Test File:** `tests/part-b/scenarios/FS-11.test.ts`
- **Trigger:** 5 captured payments missing from mock gateway settlement batch.
- **Expected Behavior:** Reconciliation flags 5 `RECONCILIATION_MISMATCH` anomaly records. Financial ledger remains untouched (NO auto-refund). Audit log records `SETTLEMENT_INVESTIGATION_LOGGED`.

### FS-12: UPI Collect Request Expiry & Mandate Timeout
- **Test File:** `tests/part-b/scenarios/FS-12.test.ts`
- **Trigger:** Customer does not approve UPI collect prompt before validity window expires.
- **Expected Behavior:** Transitions `AUTH_INITIATED -> AUTH_EXPIRED`. Zero automatic retries (mandate was actively ignored or rejected).

### FS-13: Multi-Tenant Idempotency Key Collision
- **Test File:** `tests/part-b/scenarios/FS-13.test.ts`
- **Trigger:** Merchant A and Merchant B both submit payments with the exact same UUID key `idem-uuid-shared`.
- **Expected Behavior:** Both succeed independently (HTTP 201) with distinct transactions due to composite primary key `(merchant_id, operation, key)`.

### FS-14: Database Connection Pool Exhaustion & Backpressure
- **Test File:** `tests/part-b/scenarios/FS-14.test.ts`
- **Trigger:** Extreme concurrency saturates the database connection pool.
- **Expected Behavior:** Bounded pool backpressure with deterministic timeout. Requests reject cleanly without memory leak, unhandled crash, or indefinite hang.

### FS-15: State Machine Illegal Transition Protection
- **Test File:** `tests/part-b/scenarios/FS-15.test.ts`
- **Trigger:** Operator attempts manual transition `CREATED -> REFUNDED` via API.
- **Expected Behavior:** State machine rejects with `InvalidStateTransitionException` (HTTP 422). Error response contains `allowedTransitions: ['ROUTE_SELECTED', 'ABANDONED']`. `transaction_state_log` permanently records `REJECTED_TRANSITION` audit entry.

