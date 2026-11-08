# ZeTheta Payment Orchestration Platform

> Enterprise-grade, multi-gateway payment orchestration backend built in TypeScript and PostgreSQL, implementing **Part A: Training Material & Learning Resources (printed pages 3–23)** of `Zetheta_Backend_project.pdf`.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-18-blue.svg)](https://www.postgresql.org/)
[![Tests](https://img.shields.io/badge/Tests-64%20Passed-brightgreen.svg)]()
[![OpenAPI 3.0](https://img.shields.io/badge/OpenAPI-3.0-green.svg)](http://localhost:3000/docs)

---

## 1. Overview & Key Capabilities

ZeTheta provides unified payment collection across multiple downstream payment gateways (Razorpay, Stripe, PayU, and Direct UPI). It resolves the complexities of gateway fragmentation, dynamic fee optimization, transient failover, asynchronous webhook reliability, and automated financial reconciliation.

### Core Architectural Features
- **Deterministic State Machine (FSM):** Mathematically rigorous transaction lifecycle (`CREATED`, `ROUTE_SELECTED`, `AUTH_INITIATED`, `AUTHORISED`, `CAPTURED`, `PARTIALLY_CAPTURED`, `VOIDED`, `REFUNDED`, `AUTH_TIMEOUT`, etc.).
- **Cryptographic Append-Only Audit Trail:** Historical transitions audited in `transaction_state_log`, physically protected against modification or deletion via PostgreSQL trigger `trg_state_log_immutable`.
- **Intelligent Dynamic Router:** Real-time multi-factor ranking based on 5 parameters (Success Rate 35%, Fees 20%, Latency 20%, Health 15%, Priority 10%), with normalizations and recovering gateway 20% preference rule.
- **Circuit Breakers & Rate Limiting:** Per-gateway circuit breakers (`CLOSED`, `OPEN`, `HALF_OPEN`) and outbound token-bucket rate limiting preventing cascading outages.
- **Concurrent-Safe Idempotency:** SHA-256 canonical hashing coupled with PostgreSQL transactional advisory locks (`pg_advisory_xact_lock`), proven race-condition immune under high concurrency.
- **Zero-Loss Failover (< 2s SLA):** Automatic rerouting on transient 503 failures without customer friction.
- **Strict Double-Charge Prevention:** Payment timeouts (`TIMEOUT_UNKNOWN`) transition to `AUTH_TIMEOUT` and **never** failover, eliminating duplicate debits.
- **Reliable Webhook Ingestion:** Raw-body HMAC-SHA256 signature verification, immediate deduplication, durable queue buffering (`webhook_queue`), worker leasing with `FOR UPDATE SKIP LOCKED`, exponential backoff, and Dead Letter Queue (`DLQ`).
- **Autonomous Background Reconciliation:** Automatically polices stale `AUTH_TIMEOUT` states, queries downstream APIs, safely corrects terminal states, and alerts operators on fatal financial anomalies.

---

## 2. High-Level Architecture

```mermaid
flowchart TD
    Client["Client App / Merchant"] -->|HTTPS + API Key| API["Express 5 REST API Gateway"]
    API --> Middleware["Trace & Auth Middleware"]
    Middleware --> Idem["Idempotency Manager (pg_advisory_xact_lock)"]
    Idem --> Router["Intelligent Dynamic Router (5 Weighted Factors)"]
    Router --> Breaker["Circuit Breaker (CLOSED / OPEN / HALF_OPEN)"]
    Router --> RateLimiter["Outbound Rate Limiter (Token Bucket)"]
    RateLimiter --> Adapters["Gateway Adapter Layer"]
    Adapters --> Gateways["Downstream Gateways (Razorpay, Stripe, PayU, UPI)"]
    
    API <--> DB[("PostgreSQL 18 Database<br/>(Triggers, Partial Indexes, ACID)")]
    Workers["Asynchronous Workers<br/>(Webhook Worker & Recon Worker)"] <--> DB
    Gateways -.->|Webhooks| API
```

---

## 3. Prescribed REST API Endpoints (OpenAPI 3.0)

The system exposes all **23 prescribed REST API endpoints** under `/api/v1`, documented in OpenAPI 3.0 and served interactively via Swagger UI at `http://localhost:3000/docs`:

| # | HTTP Method | Endpoint Path | Auth Required | Description |
|---|---|---|---|---|
| 1 | `POST` | `/api/v1/payments` | Merchant | Initiates a payment with `Idempotency-Key` and routes to optimal gateway |
| 2 | `GET` | `/api/v1/payments/:id` | Merchant | Retrieves payment details by transaction ID or `merchant_order_id` query |
| 3 | `POST` | `/api/v1/payments/:id/capture` | Merchant | Captures authorized funds (full or partial capture supported) |
| 4 | `POST` | `/api/v1/payments/:id/void` | Merchant | Releases/voids an uncaptured authorized hold |
| 5 | `POST` | `/api/v1/payments/:id/refund` | Merchant | Issues a partial or full refund against captured funds |
| 6 | `GET` | `/api/v1/payments/:id/timeline` | Merchant | Returns full chronological audit timeline from `transaction_state_log` |
| 7 | `GET` | `/api/v1/gateways` | Merchant/Admin | Lists all registered gateways, enabled methods, and operational status |
| 8 | `GET` | `/api/v1/gateways/:gateway/health` | Merchant/Admin | Returns circuit breaker state, health metric, and failure counters |
| 9 | `POST` | `/api/v1/gateways/:gateway/maintenance`| Admin | Toggles maintenance mode or manual administrative circuit breaker trip |
| 10 | `GET` | `/api/v1/routes/evaluate` | Merchant/Admin | Simulates dynamic router candidate scores for a given payment method |
| 11 | `GET` | `/api/v1/routes/config` | Admin | Returns current active routing factor weights |
| 12 | `PUT` | `/api/v1/routes/config` | Admin | Updates routing factor weights (sum must equal 1.00) |
| 13 | `POST` | `/api/v1/webhooks/razorpay` | Public (HMAC) | Ingests and verifies Razorpay webhook with `x-razorpay-signature` |
| 14 | `POST` | `/api/v1/webhooks/stripe` | Public (HMAC) | Ingests and verifies Stripe webhook with `stripe-signature` |
| 15 | `POST` | `/api/v1/webhooks/payu` | Public (HMAC) | Ingests and verifies PayU webhook with SHA-512 `hash` |
| 16 | `POST` | `/api/v1/webhooks/upi` | Public (HMAC) | Ingests and verifies Direct UPI webhook with HMAC signature |
| 17 | `POST` | `/api/v1/reconciliation/run` | Admin | Manually triggers immediate reconciliation batch sweep |
| 18 | `GET` | `/api/v1/reconciliation/runs` | Admin | Lists historical reconciliation pass runs and summaries |
| 19 | `GET` | `/api/v1/reconciliation/anomalies`| Admin | Returns detected financial anomalies requiring operator review |
| 20 | `GET` | `/api/v1/analytics/routing` | Admin | Returns aggregate gateway routing distribution and success rates |
| 21 | `GET` | `/api/v1/analytics/latencies` | Admin | Returns p50, p90, and p99 gateway processing latencies |
| 22 | `GET` | `/api/v1/health` | Public | Returns database connection health and worker engine status |
| 23 | `GET` | `/api/v1/admin/webhooks/dlq` | Admin | Lists quarantined Dead Letter Queue webhook events |
| * | `POST` | `/api/v1/admin/webhooks/dlq/replay`| Admin | Resets and replays quarantined DLQ events back to pending queue |

---

## 4. Getting Started & Installation

### Prerequisites
- **Node.js:** v20.x or v22.x LTS
- **PostgreSQL:** v16+ (tested against PostgreSQL 18.6)
- **npm:** v10+

### Environment Configuration
Copy the provided `.env.example` to `.env`:
```bash
cp .env.example .env
```
Key configuration parameters:
```ini
PORT=3000
NODE_ENV=development
DATABASE_URL=postgres://postgres:postgres@localhost:54332/zetheta_dev
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:54332/zetheta_test
MERCHANT_API_KEY=test_api_key_zetheta_dev
ADMIN_API_KEY=admin_secret_key_zetheta
```

### Database Migrations & Seed Data
```bash
# Run 8 Knex migrations
npm run db:migrate

# Seed historical performance fixtures (from PDF p. 10) & routing config
npm run db:seed
```

### Running the Application
```bash
# Development mode with hot-reload
npm run dev

# Compile TypeScript
npm run build

# Start production server
npm start
```
Once started, visit **`http://localhost:3000/docs`** for interactive Swagger API testing.

---

## 5. Automated Verification & Test Results

The platform includes a test suite covering unit logic, database triggers, state machine transitions, webhook pipelines, failover safety, reconciliation, API contracts, and high-contention concurrency:

```bash
# Run all 64 automated tests
npm run test:all
```

### Verified Test Summary
```
Test Files:  13 passed (13)
Tests:       64 passed (64)
Pass Rate:   100%
Exit Code:   0
```

- **Unit Tests (18 tests):** State machine, canonical idempotency hashing, 5-factor scoring, circuit breaker cooldowns, token-bucket rate limiter, HMAC signatures.
- **Integration Tests (19 tests):** Database schema & immutability triggers, payment authorization/capture/refund lifecycle, safe zero-loss failover, webhook pipeline leasing, reconciliation anomaly detection.
- **E2E Contract Tests (24 tests):** Full HTTP validation across all 23 prescribed endpoints.
- **Concurrency & Contention Tests (3 tests):** 25 simultaneous concurrent requests bearing the identical idempotency key; idempotency key tampering rejection; race condition resistance on simultaneous partial captures.

---

## 6. Docker & Docker Compose Deployment

Run the complete platform including PostgreSQL 16 and the ZeTheta API using Docker Compose:
```bash
# Build and launch all containers
docker-compose up --build -d

# View service logs
docker-compose logs -f api
```

---

## 7. Documentation Index

Comprehensive engineering documents are located in the `docs/` directory:
- [System Architecture](file:///docs/architecture.md) — Detailed design, component flows, sequence diagrams.
- [Transaction State Machine](file:///docs/state-machine.md) — Formal FSM transition rules, invariants, append-only trigger.
- [Intelligent Routing Engine](file:///docs/routing-design.md) — 5 weighted parameters, normalization equations, half-open 20% rule.
- [Relational Data Model](file:///docs/data-model.md) — Entity-relationship diagram and table responsibilities.
- [Database Architecture](file:///docs/database-architecture.md) — Schema DDL, migrations, indexes, constraints, locking strategy.
- [Webhook Reliability Pipeline](file:///docs/webhook-reliability.md) — Ingestion, deduplication, worker leasing, backoff, DLQ.
- [Failover Safety & Double-Charge Prevention](file:///docs/failover-safety.md) — 2-second failover window and timeout protection.
- [Requirements Traceability Matrix](file:///docs/requirements-traceability.md) — Bidirectional mapping of Part A requirements to code and tests.
- [Test Execution Report](file:///docs/test-results.md) — Detailed breakdown of test suites and verified invariants.
- [Operational Limitations](file:///docs/limitations.md) — Mock/sandbox disclosures and non-production regulatory boundaries.
- [OpenAPI Specification](file:///docs/openapi.yaml) — Complete OpenAPI 3.0 schema for all 23 REST endpoints.

---

## 8. Non-Production Scope Disclaimer

This codebase strictly implements **Part A (printed pages 3–23)** of the assignment. Gateway adapters operate in automated mock/sandbox mode. No live banking connections, PCI DSS certification, RBI tokenization hardware, or real financial funds are utilized or claimed.

