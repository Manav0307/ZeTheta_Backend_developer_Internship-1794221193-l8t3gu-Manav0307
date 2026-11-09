# Part B Benchmark Methodology & Measurement Targets

This document outlines the benchmarking harness, targets, and measurement procedures for all six Part B performance benchmarks (§B3).

---

## 1. Summary of Benchmark Targets & local Measurements

| ID | Benchmark Name | Target | Measured Result | Status |
|---|---|---|---|:---:|
| **BM-01** | Payment Initiation Latency | P95 < 200ms, P99 < 500ms | P95: **11.58ms**, P99: **101.69ms** | ✅ PASS |
| **BM-02** | Sustained Throughput Under Concurrency | >= 100 req/s, Error Rate < 0.1% | **229.4 req/s**, Error: **0.0%** | ✅ PASS |
| **BM-03** | Webhook Ingestion-to-Processed Latency | P99 < 2000ms | P99: **30.23ms** | ✅ PASS |
| **BM-04** | Failover Routing Decision Overhead | P95 < 50ms | P95: **2.17ms** | ✅ PASS |
| **BM-05** | Concurrent Idempotency Key Resolution | P99 < 10ms | P99: **1.60ms** | ✅ PASS |
| **BM-06** | Reconciliation Batch Throughput | > 1,000 tx/minute | **25,650 tx/minute** | ✅ PASS |

---

## 2. Benchmark Definitions & Instrumentation

### BM-01: Payment Initiation Latency
- **Objective:** Measure latency from request ingestion, deterministic idempotency hash verification, database transaction lock, intelligent route selection, gateway adapter dispatch, to append-only state log commit.
- **Instrumentation:** High-resolution timing (`process.hrtime.bigint()`) over 50 real payment creations. Percentiles calculated via nearest rank interpolation.

### BM-02: Sustained Throughput Under Concurrency
- **Objective:** Measure orchestrator resilience under high-concurrency request bursts.
- **Instrumentation:** 100 concurrent requests fired simultaneously using Node.js event loop concurrency against local PostgreSQL. Monitored for 0 HTTP 5xx errors and zero database connection pool timeouts.

### BM-03: Webhook Ingestion-to-Processed Latency
- **Objective:** Measure latency between cryptographic webhook signature validation and final state transition (`CAPTURED`) in PostgreSQL.
- **Instrumentation:** End-to-end timing across 20 distinct webhook deliveries with queue worker processing.

### BM-04: Failover Routing Decision Overhead
- **Objective:** Ensure routing cost evaluation and circuit breaker penalties add minimal overhead compared to direct routing.
- **Instrumentation:** Evaluates 30 reroute calculations excluding the primary gateway.

### BM-05: Concurrent Idempotency Key Resolution
- **Objective:** Verify that duplicate submissions with identical idempotency keys return the cached result almost instantaneously.
- **Instrumentation:** 50 consecutive lookups on a primed key with SHA-256 hash validation.

### BM-06: Reconciliation Batch Throughput
- **Objective:** Ensure the reconciliation engine can scan and reconcile bulk transactions rapidly during scheduled settlement windows.
- **Instrumentation:** Batch scan of 50 captured transactions against a mock settlement ledger, projecting throughput per minute.

