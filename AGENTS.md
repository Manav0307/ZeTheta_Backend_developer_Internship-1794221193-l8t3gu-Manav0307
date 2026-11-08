# Agent Development & Engineering Conventions

Welcome to the **ZeTheta Payment Orchestration Platform** repository. This document outlines the enduring architecture rules, invariants, and workflows for AI agents and engineers working on this codebase.

---

## 1. Scope & Primary Directive

- **Scope Restriction:** All code in this repository implements **Part A: Training Material & Learning Resources (printed pages 3–23)** of `Zetheta_Backend_project.pdf`.
- **Exclusion Rule:** Under no circumstances should requirements, schemas, or features from **Parts B, C, D, E, or F** be introduced into this codebase.
- **Production Readiness Disclaimer:** The gateway adapters in `src/gateways/` are mock and sandbox implementations. Never claim external live banking production readiness or use real financial credentials.

---

## 2. Invariants That Must NEVER Be Broken

1. **Audit Ledger Immutability:**
   Table `transaction_state_log` is protected by the PostgreSQL trigger `trg_state_log_immutable`. Any attempt to execute an `UPDATE` or `DELETE` on this table will throw an uncatchable database exception. Always transition states via `TransactionRepository.transitionState()`, which issues an append-only `INSERT`.

2. **No Double-Charge Failover Rule:**
   - On `TIMEOUT_UNKNOWN` (gateway socket timeout or network drop), you **must never failover** to another gateway. Transition the transaction to `AUTH_TIMEOUT`, mark the idempotency key `UNKNOWN`, and schedule reconciliation.
   - Failover is strictly permitted **only** on verified `TRANSIENT_FAILURE` (e.g., HTTP 503 Service Unavailable), where the downstream gateway definitively confirms funds were not held.
   - When rerouting, always pass `excludeGateways: [failedGateway]` so the router does not bounce back to the gateway that just failed.

3. **Minor Units Financial Arithmetic:**
   - Never store floats or decimals for currency amounts. All monetary fields are integer minor currency units (`amount_minor`, `authorized_minor`, `captured_minor`, `refunded_minor`) typed as `NUMERIC(16,0)` in PostgreSQL and `bigint` / string in TypeScript.
   - Enforce: $\text{captured\_minor} \le \text{authorized\_minor}$ and $\text{refunded\_minor} + \text{reserved\_refund\_minor} \le \text{captured\_minor}$.

4. **Idempotency Payload Integrity:**
   - The payload passed to `IdempotencyManager.claimKey()` must contain **only deterministic business parameters** (`merchantId`, `merchantOrderId`, `amountMinor`, `currency`, `paymentMethod`, `captureMode`, `metadata`).
   - Never include ephemeral per-request trace IDs (`traceId`) or timestamps in the hashed payload, as doing so breaks deduplication for concurrent identical retries.

5. **Single Active Attempt Lock:**
   - The partial unique index `idx_single_active_attempt_per_tx` restricts concurrent active attempts. Never bypass this constraint.

---

## 3. Developer & CLI Cheat Sheet

### Running Tests
```bash
# Run all 64 automated tests
npm run test:all

# Run specific suites
npm run test             # Unit tests (18 tests)
npm run test:integration # Integration tests (19 tests)
npm run test:e2e         # End-to-end & Concurrency tests (27 tests)
```

### Database Management
```bash
# Run Knex migrations
npm run db:migrate

# Rollback last migration batch
npm run db:rollback

# Seed historical metrics and default configurations
npm run db:seed
```

### Build & Typecheck
```bash
# Run TypeScript compilation
npm run build
```

### Starting the Server
```bash
# Run in development mode with hot-reloading
npm run dev

# Run compiled production server
npm start
```
Interactive Swagger documentation is served at `http://localhost:3000/docs`.
OpenAPI 3.0 specification is located at `docs/openapi.yaml`.

