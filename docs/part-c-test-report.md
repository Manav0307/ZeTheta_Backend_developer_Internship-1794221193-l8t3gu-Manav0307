# Part C Test Report: Case Studies & Scenario Validation

**Execution Date:** 2026-11-14  
**Environment:** Node.js v22.21.0, TypeScript 5.8, PostgreSQL 18.6 (x86_64-windows), Vitest v5.1.0  
**Overall Status:** ✅ ALL 16 PART C TESTS PASSED (100%), ALL 15 PART B SCENARIOS PASSED (100%)  

---

## 1. Part C Case Study Test Evidence Matrix

| Test Suite / ID | Scenario | Expected Result | Actual Result | Status | Execution Command |
|---|---|---|---|---|---|
| **C1-01** | Concurrency Safety & Double Charge | 2 concurrent requests with same idempotency key produce exactly 1 charge | 1 transaction created, 1 charge, 0 double-charges | ✅ **PASS** | `npx vitest run tests/case-studies/C1-double-charge-prevention.test.ts` |
| **C1-02** | Retry Jitter Bounds | Exponential backoff adheres to 1s, 2s, 4s bounds with ±25% randomized jitter | Delays bounded within [750ms, 1250ms], [1500ms, 2500ms], [3000ms, 5000ms] | ✅ **PASS** | `npx vitest run tests/case-studies/C1-double-charge-prevention.test.ts` |
| **C1-03** | Durable Async Retry Worker | Worker re-delivery of completed job does not issue a duplicate financial charge | Detected terminal CAPTURED state; marked job COMPLETED without downstream call | ✅ **PASS** | `npx vitest run tests/case-studies/C1-double-charge-prevention.test.ts` |
| **C1-04** | Circuit Breaker Fast Failover | 5 consecutive timeouts trip breaker OPEN and routes traffic away | Breaker state = OPEN; subsequent requests routed to alternative healthy gateway | ✅ **PASS** | `npx vitest run tests/case-studies/C1-double-charge-prevention.test.ts` |
| **C1-05** | Ambiguous Timeout Safety | Gateway timeout marks AUTH_TIMEOUT and preserves UNKNOWN idempotency | HTTP 202 Accepted; idempotency status UNKNOWN; exactly 1 attempt; 0 failover charges | ✅ **PASS** | `npx vitest run tests/case-studies/C1-double-charge-prevention.test.ts` |
| **C2-01** | Missing Settlement Detection | 5 captured transactions missing in settlement file generate anomalies | 5 anomaly records in `reconciliation_anomalies`; 0 auto-refunds; state stays CAPTURED | ✅ **PASS** | `npx vitest run tests/case-studies/C2-settlement-reconciliation.test.ts` |
| **C2-02** | Confirmed Settlement Inclusion | Transactions confirmed in settlement batch transition to SETTLED | State transitions to SETTLED; `settlement_status = 'SETTLED'`; 0 discrepancies | ✅ **PASS** | `npx vitest run tests/case-studies/C2-settlement-reconciliation.test.ts` |
| **C2-03** | Dispute Webhook Ingestion | `dispute.created` webhook flags high-severity anomaly without auto-refund | Logged dispute anomaly; status OPEN; zero unauthorized refunds issued | ✅ **PASS** | `npx vitest run tests/case-studies/C2-settlement-reconciliation.test.ts` |
| **C3-01** | Strict Fulfilment Gate | Order fulfilment is blocked during pending `AUTH_INITIATED` | `canFulfil` returns false; `triggerFulfilment` throws `FULFILMENT_NOT_PERMITTED` | ✅ **PASS** | `npx vitest run tests/case-studies/C3-upi-fulfilment-gate.test.ts` |
| **C3-02** | Mandate Expiration Guard | Expired UPI collect mandate permits zero fulfilment events and 0 retries | State = `AUTH_EXPIRED`; customer notified; fulfilment strictly blocked; 0 retries | ✅ **PASS** | `npx vitest run tests/case-studies/C3-upi-fulfilment-gate.test.ts` |
| **C3-03** | Confirmed Capture Fulfilment | Authoritative capture emits exactly 1 fulfilment event; duplicates suppressed | Emits `fulfilment.allowed` on capture; subsequent trigger returns null (idempotent) | ✅ **PASS** | `npx vitest run tests/case-studies/C3-upi-fulfilment-gate.test.ts` |
| **C4-01** | Validly-Signed Amount Mismatch | Validly signed ₹10 webhook linked to ₹50,000 order is rejected | Caught `WEBHOOK_AMOUNT_MISMATCH`; logged audit alarm; order state remains AUTHORISED | ✅ **PASS** | `npx vitest run tests/case-studies/C4-webhook-replay-fraud.test.ts` |
| **C4-02** | Currency Mismatch Guard | Validly signed webhook with wrong currency (USD vs INR) is rejected | Caught `WEBHOOK_CURRENCY_MISMATCH`; logged audit alarm; state remains AUTHORISED | ✅ **PASS** | `npx vitest run tests/case-studies/C4-webhook-replay-fraud.test.ts` |
| **C4-03** | Signature Tamper Rejection | Bit-flipped payload is rejected at webhook ingress with 401 | HTTP 401 `WEBHOOK_SIGNATURE_INVALID`; source IP logged in security audit | ✅ **PASS** | `npx vitest run tests/case-studies/C4-webhook-replay-fraud.test.ts` |
| **C5-01** | Connection Decoupling | DB pool clients are released during external gateway HTTP calls | No clients checked out during gateway latency; waiting pool count unchanged | ✅ **PASS** | `npx vitest run tests/case-studies/C5-connection-pool-stampede.test.ts` |
| **C5-02** | Fail-Fast HTTP 503 | Pool exhaustion triggers HTTP 503 with Retry-After header | Returned HTTP 503 `SERVICE_UNAVAILABLE`; `Retry-After: 5`; zero DB error recursion | ✅ **PASS** | `npx vitest run tests/case-studies/C5-connection-pool-stampede.test.ts` |

---

## 2. Part B Failure Scenarios Regression Verification

| Scenario ID | Name | Target Requirement | Status | Evidence Path |
|---|---|---|---|---|
| `FS-01` | Gateway Timeout During Auth | Failover within 2s; no double charge | ✅ **PASS** | `tests/part-b/scenarios/FS-01.test.ts` |
| `FS-02` | Webhook Deduplication | Idempotent receipt; no duplicate transitions | ✅ **PASS** | `tests/part-b/scenarios/FS-02.test.ts` |
| `FS-03` | Concurrent Double-Click | Lock contention handled; single charge | ✅ **PASS** | `tests/part-b/scenarios/FS-03.test.ts` |
| `FS-04` | Gateway 502 Bad Gateway | Exponential retry; successful capture | ✅ **PASS** | `tests/part-b/scenarios/FS-04.test.ts` |
| `FS-05` | Card Insufficient Funds | Terminal decline; no failover | ✅ **PASS** | `tests/part-b/scenarios/FS-05.test.ts` |
| `FS-06` | Out-of-Order Webhook | Webhook arrives before API returns | ✅ **PASS** | `tests/part-b/scenarios/FS-06.test.ts` |
| `FS-07` | Partial Capture Race | Concurrent captures capped at authorized | ✅ **PASS** | `tests/part-b/scenarios/FS-07.test.ts` |
| `FS-08` | Refund Exceeding Captured | Over-refund strictly rejected | ✅ **PASS** | `tests/part-b/scenarios/FS-08.test.ts` |
| `FS-09` | Multi-Server Distributed Duplication | Distributed idempotency enforced | ✅ **PASS** | `tests/part-b/scenarios/FS-09.test.ts` |
| `FS-10` | Webhook Signature Tamper | 401 Unauthorized + Source IP logged | ✅ **PASS** | `tests/part-b/scenarios/FS-10.test.ts` |
| `FS-11` | Silent Settlement Discrepancy | Anomaly flagged; zero auto-refunds | ✅ **PASS** | `tests/part-b/scenarios/FS-11.test.ts` |
| `FS-12` | UPI Mandate Timeout | AUTH_EXPIRED transition + notification | ✅ **PASS** | `tests/part-b/scenarios/FS-12.test.ts` |
| `FS-13` | Circuit Breaker Half-Open Probe | Single test transaction during recovery | ✅ **PASS** | `tests/part-b/scenarios/FS-13.test.ts` |
| `FS-14` | Connection Pool Exhaustion | Graceful handling without deadlocks | ✅ **PASS** | `tests/part-b/scenarios/FS-14.test.ts` |
| `FS-15` | Illegal State Transition | State machine rejects illegal transitions | ✅ **PASS** | `tests/part-b/scenarios/FS-15.test.ts` |

---

## 3. Financial Integrity Audit
- **Command:** `npm run partb:integrity`
- **Result:** 10/10 Invariants passed (0 violations).

