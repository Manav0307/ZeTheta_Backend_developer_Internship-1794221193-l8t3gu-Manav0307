# Part B Failure Scenario Verification Catalog

**Generated:** 2026-11-09T10:12:37.848Z  
**Validation Status:** ✅ 15/15 Scenarios Passed (100% Pass Rate)  

| Scenario ID | Scenario Name | Test File | Verification Summary | Status |
|---|---|---|---|---|
| `FS-01` | **Gateway Timeout During Authorization** | `tests/part-b/scenarios/FS-01.test.ts` | Breaker failure incremented, alternate card gateway completes, <2s latency, double-charge rule verified. | ✅ PASS |
| `FS-02` | **Duplicate Webhook Delivery 3x** | `tests/part-b/scenarios/FS-02.test.ts` | Identical payment.captured ingested 3x, all HTTP 200, exactly 1 state transition, 0 duplicate charges. | ✅ PASS |
| `FS-03` | **Double Submit Under High Concurrency** | `tests/part-b/scenarios/FS-03.test.ts` | Concurrent identical Idempotency-Key requests handled safely, exactly 1 transaction created. | ✅ PASS |
| `FS-04` | **502 During Capture with Exponential Backoff** | `tests/part-b/scenarios/FS-04.test.ts` | PayU 502 backoff (1s, 2s, 4s), late gateway status check, terminal CAPTURE_FAILED upon exhaustion. | ✅ PASS |
| `FS-05` | **Partial Capture and Remainder Hold Handling** | `tests/part-b/scenarios/FS-05.test.ts` | Captured ₹800 of ₹1200, PARTIALLY_CAPTURED state, void remainder released hold cleanly. | ✅ PASS |
| `FS-06` | **Early Webhook Arrival Race Resolution** | `tests/part-b/scenarios/FS-06.test.ts` | Stripe webhook arrives before sync auth, state moves to CAPTURED, sync handler resolves idempotently. | ✅ PASS |
| `FS-07` | **Cascade Failure & Method-Fit Routing** | `tests/part-b/scenarios/FS-07.test.ts` | Preserves payment method constraints: UPI never routed to Card-only Stripe; Stripe 429 backoff respected. | ✅ PASS |
| `FS-08` | **Refund on Already-Settled Payment** | `tests/part-b/scenarios/FS-08.test.ts` | Payment in SETTLED state refunded: SETTLED -> REFUND_INITIATED -> REFUNDED without balance corruption. | ✅ PASS |
| `FS-09` | **Multi-Process Idempotency Race** | `tests/part-b/scenarios/FS-09.test.ts` | 5 simultaneous competing requests on identical key: exactly 1 payment created, 0 duplicate debits. | ✅ PASS |
| `FS-10` | **Webhook Tampering & Signature Verification** | `tests/part-b/scenarios/FS-10.test.ts` | Tampered payload rejected with HTTP 401 WEBHOOK_SIGNATURE_INVALID, DB state preserved. | ✅ PASS |
| `FS-11` | **Missing Settlements in Batch Reconciliation** | `tests/part-b/scenarios/FS-11.test.ts` | 5 missing settlements flagged as RECONCILIATION_MISMATCH, NO auto-refund, audit investigation logged. | ✅ PASS |
| `FS-12` | **UPI Collect Request Expiry & Mandate Timeout** | `tests/part-b/scenarios/FS-12.test.ts` | Customer unapproved UPI collect mandate expires to AUTH_EXPIRED with 0 retries. | ✅ PASS |
| `FS-13` | **Multi-Tenant Idempotency Collision** | `tests/part-b/scenarios/FS-13.test.ts` | Two merchants using identical UUID idempotency key succeed independently via composite primary key. | ✅ PASS |
| `FS-14` | **Database Pool Exhaustion & Backpressure** | `tests/part-b/scenarios/FS-14.test.ts` | Bounded pool saturation handles backpressure gracefully without connection leak or process hang. | ✅ PASS |
| `FS-15` | **State Machine Illegal Transition Protection** | `tests/part-b/scenarios/FS-15.test.ts` | CREATED -> REFUNDED jump rejected with 422, allowed transitions returned, REJECTED_TRANSITION logged. | ✅ PASS |
