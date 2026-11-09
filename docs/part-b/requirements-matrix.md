# Part B Requirements Traceability Matrix

This document maps every requirement from **Part B (§B1–B5, printed PDF pages 24–33)** of `Zetheta_Backend_project.pdf` to its concrete codebase implementation, automated tests, and benchmarks.

---

## 1. Specification Mapping Matrix

| PDF Section | Requirement Summary | Implementation Components | Verification Artifacts | Status |
|---|---|---|---|:---:|
| **§B1.1** | Gateway Failure Modes (FS-01 to FS-04) | `src/modules/gateway-mocks/`, `src/gateways/`, `src/modules/payments/payment.service.ts` | `tests/part-b/scenarios/FS-01.test.ts` to `FS-04.test.ts` | ✅ PASS |
| **§B1.2** | Lifecycle Edge Cases (FS-05, FS-06, FS-08) | `src/modules/state-machine/`, `src/modules/webhooks/webhook.service.ts` | `tests/part-b/scenarios/FS-05.test.ts`, `FS-06.test.ts`, `FS-08.test.ts` | ✅ PASS |
| **§B1.3** | High-Load & Concurrency (FS-03, FS-07, FS-09, FS-14) | `src/modules/idempotency/`, `src/modules/routing/`, `src/database/connection.ts` | `tests/part-b/scenarios/FS-03.test.ts`, `FS-07.test.ts`, `FS-09.test.ts`, `FS-14.test.ts` | ✅ PASS |
| **§B1.4** | Integrity & Security (FS-10, FS-11, FS-12, FS-13, FS-15) | `src/shared/errors/`, `src/modules/reconciliation/`, `src/database/repositories/` | `tests/part-b/scenarios/FS-10.test.ts`, `FS-11.test.ts`, `FS-12.test.ts`, `FS-13.test.ts`, `FS-15.test.ts` | ✅ PASS |
| **§B2** | Deterministic Mock Gateways | `src/modules/gateway-mocks/` (Razorpay, Stripe, PayU, UPI, Express router) | `tests/part-b/scenarios/` (All 15), `/mock/:gateway/*` endpoints | ✅ PASS |
| **§B3** | Six Performance Benchmarks | `scripts/part-b-benchmarks.ts`, `performance/k6/` | `artifacts/part-b/benchmark-results.json`, `artifacts/part-b/benchmark-results.md` | ✅ PASS |
| **§B4** | Offline Docker Compose Deployment | `docker-compose.yml` (Postgres 15, API, Webhook Worker, Reconcile Worker) | `docker-compose.yml` validation | ✅ PASS |
| **§B5** | Machine-Readable Artifacts & Reports | `scripts/part-b-report.ts`, `scripts/part-b-integrity.ts` | `artifacts/part-b/`, `docs/part-b/` | ✅ PASS |

---

## 2. Invariants Preserved from Part A

1. **Audit Ledger Immutability:** `transaction_state_log` guarded by PostgreSQL trigger `trg_state_log_immutable`. All state changes append-only.
2. **Double-Charge Prevention Rule:** No failover on downstream socket timeout (`TIMEOUT_UNKNOWN`); failover permitted only on confirmed `TRANSIENT_FAILURE`.
3. **Integer Minor Units:** All monetary values stored and calculated as exact integer minor units (`amount_minor`, `authorized_minor`, `captured_minor`, `refunded_minor`).
4. **Deterministic Idempotency Payload:** Hashed payload includes business values only (`merchant_id`, `merchant_order_id`, `amount_minor`, `currency`, `payment_method`), excluding trace IDs.
5. **Single Active Attempt Lock:** Enforced by PostgreSQL partial unique index `idx_single_active_attempt_per_tx`.

