# Requirements Traceability Matrix (Part A: Pages 3–23)

## 1. Compliance & Scope Verification

This document provides a strict, bidirectional traceability matrix linking every functional requirement in **Part A (printed pages 3–23)** of `Zetheta_Backend_project.pdf` to its concrete source implementation files, database artifacts, and automated verification tests.

Requirements from Parts B, C, D, E, and F are strictly excluded from the scope of this implementation.

---

## 2. Bidirectional Traceability Matrix

| Ref | Requirement Description (PDF Part A) | PDF Page | Implementation Source | Database Tables / Constraints | Automated Verification Test | Status |
|---|---|---|---|---|---|---|
| **REQ-01** | Multi-Gateway Payment Orchestration Core | pp. 3–5 | `src/app.ts`, `src/modules/payments/payment.service.ts` | `transactions`, `payment_attempts` | `tests/integration/payment-lifecycle.test.ts` | **VERIFIED** |
| **REQ-02** | 2-Phase Authorization & Capture (Card / Netbanking) | pp. 5–6 | `src/modules/payments/payment.service.ts` | `transactions.state = 'AUTHORISED'` | `tests/integration/payment-lifecycle.test.ts` | **VERIFIED** |
| **REQ-03** | Instant Capture / Direct Settlement (UPI) | pp. 6–7 | `src/gateways/upi.adapter.ts`, `src/modules/state-machine/` | `transactions.state = 'CAPTURED'` | `tests/integration/payment-lifecycle.test.ts` | **VERIFIED** |
| **REQ-04** | Partial Capture & Remainder Capture | p. 7 | `src/database/repositories/capture.repository.ts` | `capture_operations`, `chk_captured_le_authorized` | `tests/integration/payment-lifecycle.test.ts` | **VERIFIED** |
| **REQ-05** | Voiding Authorized Holds | p. 7 | `src/modules/payments/payment.service.ts` | `transactions.state = 'VOIDED'` | `tests/integration/payment-lifecycle.test.ts` | **VERIFIED** |
| **REQ-06** | Partial & Full Refunds with Balance Tracking | p. 8 | `src/database/repositories/refund.repository.ts` | `refunds`, `chk_refunded_le_captured` | `tests/integration/payment-lifecycle.test.ts` | **VERIFIED** |
| **REQ-07** | Finite State Machine & Valid Transitions | pp. 5–8 | `src/modules/state-machine/index.ts` | `transaction_state_log` | `tests/unit/state-machine.test.ts` | **VERIFIED** |
| **REQ-08** | Append-Only Audit Logging & Immutable Triggers | p. 8 | `src/database/migrations/20261108000008_create_triggers_and_indexes.ts` | `trg_state_log_immutable`, `forbid_audit_mutation` | `tests/integration/db-schema-triggers.test.ts` | **VERIFIED** |
| **REQ-09** | Intelligent Dynamic Router with 5 Weighted Factors | p. 10 | `src/modules/routing/index.ts` | `routing_config`, `gateway_routes` | `tests/unit/routing.test.ts` | **VERIFIED** |
| **REQ-10** | Factor Normalization (Fees, Latency, Success Rate) | p. 10 | `src/modules/routing/index.ts` | `gateway_health_metrics` | `tests/unit/routing.test.ts` | **VERIFIED** |
| **REQ-11** | Historical Performance Seed Data | p. 10 | `src/database/seeds/01_initial_seeds.ts` | `gateway_health_metrics` seeded with PDF p. 10 stats | `tests/unit/routing.test.ts` | **VERIFIED** |
| **REQ-12** | Circuit Breaker (CLOSED / OPEN / HALF-OPEN) | pp. 11–12 | `src/modules/circuit-breaker/index.ts` | `gateway_circuit_breakers` | `tests/unit/circuit-breaker.test.ts` | **VERIFIED** |
| **REQ-13** | Circuit Breaker Half-Open 20% Preference Rule | p. 12 | `src/modules/routing/index.ts` | `gateway_circuit_breakers.state = 'HALF_OPEN'` | `tests/unit/routing.test.ts` | **VERIFIED** |
| **REQ-14** | Outbound Rate Limiter (Token Bucket / Sliding Window) | p. 13 | `src/modules/rate-limiter/index.ts` | In-memory token bucket + gateway config limits | `tests/unit/rate-limiter.test.ts` | **VERIFIED** |
| **REQ-15** | Idempotency Manager with SHA-256 Hashing | pp. 13–14 | `src/modules/idempotency/index.ts` | `idempotency_keys`, `pg_advisory_xact_lock` | `tests/e2e/concurrency.test.ts` | **VERIFIED** |
| **REQ-16** | 4 Payment Gateway Adapters (Razorpay, Stripe, PayU, UPI) | pp. 15–17 | `src/gateways/` (`razorpay`, `stripe`, `payu`, `upi`) | `gateway_config` | `tests/e2e/api-contracts.test.ts` | **VERIFIED** |
| **REQ-17** | Webhook Raw Body HMAC Signature Verification | pp. 18–19 | `src/modules/webhooks/webhook.service.ts` | `processed_webhook_events` | `tests/unit/webhook-signatures.test.ts` | **VERIFIED** |
| **REQ-18** | Webhook Deduplication & Ingestion Acknowledgment | p. 19 | `src/modules/webhooks/webhook.service.ts` | `processed_webhook_events(gateway, event_id)` PK | `tests/integration/webhook-pipeline.test.ts` | **VERIFIED** |
| **REQ-19** | Durable Webhook Queue, Worker Leasing & Backoff | pp. 19–20 | `src/workers/webhook.worker.ts` | `webhook_queue`, `FOR UPDATE SKIP LOCKED` | `tests/integration/webhook-pipeline.test.ts` | **VERIFIED** |
| **REQ-20** | Webhook Dead Letter Queue (DLQ) & Admin Replay | p. 20 | `src/api/controllers/admin-dlq.controller.ts` | `webhook_queue.status = 'DLQ'` | `tests/e2e/api-contracts.test.ts` | **VERIFIED** |
| **REQ-21** | Automated Zero-Loss Failover (< 2s SLA) | pp. 21–22 | `src/modules/payments/payment.service.ts` | `payment_attempts`, `idx_single_active_attempt_per_tx` | `tests/integration/failover-safety.test.ts` | **VERIFIED** |
| **REQ-22** | Double-Charge Safety (Timeout vs Transient Failure) | p. 22 | `src/modules/payments/payment.service.ts` | `transactions.state = 'AUTH_TIMEOUT'` | `tests/integration/failover-safety.test.ts` | **VERIFIED** |
| **REQ-23** | Background Reconciliation Engine & Anomaly Detection | pp. 22–23 | `src/modules/reconciliation/reconciliation.service.ts` | `reconciliation_runs`, `reconciliation_anomalies` | `tests/integration/reconciliation.test.ts` | **VERIFIED** |
| **REQ-24** | All 23 REST API Endpoints Documented in OpenAPI 3.0 | pp. 14, 23 | `docs/openapi.yaml`, `src/api/routes/` | Full Express routing tree | `tests/e2e/api-contracts.test.ts` | **VERIFIED** |
| **REQ-25** | Database Migrations, Seeds & Bi-Directional Rollbacks | All | `src/database/migrations/`, `src/database/seeds/` | PostgreSQL 18 relational schema | `tests/integration/db-schema-triggers.test.ts` | **VERIFIED** |

---

## 3. Coverage Summary

- **Total Part A Requirements:** 25 formal requirement categories.
- **Implemented:** 25 / 25 (100%).
- **Automated Verification Tests Passing:** 64 / 64 (100%).
- **Exclusions:** Requirements from Parts B, C, D, E, and F were strictly not implemented, respecting project scoping rules.

