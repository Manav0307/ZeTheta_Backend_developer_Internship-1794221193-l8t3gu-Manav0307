# Database Architecture & Engineering Design

## 1. Relational Engineering Foundations

The ZeTheta persistence layer is implemented in PostgreSQL 18.6 using Knex.js migrations. It enforces strict ACID guarantees, pessimistic concurrency control, referential integrity via foreign key constraints, and cryptographically verifiable audit logging.

---

## 2. Distinction Between `[PDF]` Requirements and `[DESIGN]` Decisions

The schema reconciles the explicit functional requirements from `Zetheta_Backend_project.pdf` (Part A, pp. 3–23) with the concrete database specifications from `Zetheta_Part_A_Complete_Database_Schema.md` and `Zetheta_Master_Implementation_Prompt.md`:

| Area | Requirement Source | Implementation Detail |
|---|---|---|
| **Multi-Gateway Routing** | `[PDF]` (p. 10) | Weighted factors: Success Rate (0.35), Fees (0.20), Latency (0.20), Health (0.15), Priority (0.10). |
| **Route Audit Persistence** | `[DESIGN]` | Dedicated table `gateway_routes` storing candidate scores and winning selection. |
| **Transaction State Machine** | `[PDF]` (pp. 5–8) | States `CREATED`, `AUTHORISED`, `CAPTURED`, `REFUNDED`, `VOIDED`, etc. |
| **Append-Only Immutability** | `[DESIGN]` | Trigger `trg_state_log_immutable` raising exceptions on `UPDATE` or `DELETE` in `transaction_state_log`. |
| **Partial Operations** | `[DESIGN]` | Tables `capture_operations` and `refunds` with composite FKs `(attempt_id, transaction_id)`. |
| **Single Active Attempt Lock**| `[DESIGN]` | Partial unique index `idx_single_active_attempt_per_tx` ensuring at most one active attempt per payment. |
| **Idempotency Advisory Locks** | `[DESIGN]` | Composite PK `(merchant_id, operation, key)` with `pg_advisory_xact_lock` hash serialization. |
| **Durable Webhook Queue** | `[DESIGN]` | Table `webhook_queue` supporting worker leasing, exponential backoff, and DLQ status. |
| **Reconciliation Storage** | `[DESIGN]` | Tables `reconciliation_runs`, `reconciliation_log`, and `reconciliation_anomalies`. |

---

## 3. Knex Migrations Breakdown

The schema is structured into 8 modular, reversible TypeScript migrations in `src/database/migrations/`:

| # | Migration File | Primary Tables Created / Managed |
|---|---|---|
| 1 | `20261108000001_create_config_tables.ts` | `gateway_config`, `routing_config` |
| 2 | `20261108000002_create_transactions_and_attempts.ts` | `transactions`, `payment_attempts` |
| 3 | `20261108000003_create_routes_breakers_metrics.ts` | `gateway_routes`, `gateway_circuit_breakers`, `gateway_health_metrics` |
| 4 | `20261108000004_create_state_log_and_idempotency.ts` | `transaction_state_log`, `idempotency_keys` |
| 5 | `20261108000005_create_captures_and_refunds.ts` | `capture_operations`, `refunds` |
| 6 | `20261108000006_create_webhooks_tables.ts` | `processed_webhook_events`, `webhook_queue` |
| 7 | `20261108000007_create_reconciliation_tables.ts` | `reconciliation_runs`, `reconciliation_log`, `reconciliation_anomalies` |
| 8 | `20261108000008_create_triggers_and_indexes.ts` | Trigger function `forbid_audit_mutation`, `trg_state_log_immutable`, and partial unique indexes |

All migrations provide strictly bidirectional `up` and `down` methods, verified via automated rollback and remigration test suites.

---

## 4. Key Constraints & Data Integrity Guardrails

### 4.1 Minor Currency Integer Arithmetic
All monetary balances are stored as numeric minor units (e.g. ₹100.00 = `10000` paise):
```sql
amount_minor NUMERIC(16,0) NOT NULL CHECK (amount_minor > 0),
authorized_minor NUMERIC(16,0) NOT NULL DEFAULT 0 CHECK (authorized_minor >= 0),
captured_minor NUMERIC(16,0) NOT NULL DEFAULT 0 CHECK (captured_minor >= 0),
refunded_minor NUMERIC(16,0) NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0),
reserved_refund_minor NUMERIC(16,0) NOT NULL DEFAULT 0 CHECK (reserved_refund_minor >= 0),
CONSTRAINT chk_captured_le_authorized CHECK (captured_minor <= authorized_minor)
```

### 4.2 Single Active Attempt Partial Index
To prevent simultaneous parallel attempts against multiple gateways on the same transaction:
```sql
CREATE UNIQUE INDEX idx_single_active_attempt_per_tx
    ON payment_attempts (transaction_id)
    WHERE status IN ('INITIATED', 'PENDING');
```

### 4.3 Composite Foreign Keys for Operational Lineage
Captures and refunds reference both the transaction AND the specific authorized payment attempt:
```sql
CONSTRAINT capture_operations_attempt_id_transaction_id_fkey
    FOREIGN KEY (attempt_id, transaction_id)
    REFERENCES payment_attempts(id, transaction_id)
    ON DELETE RESTRICT
```

---

## 5. Concurrency & Locking Architecture

### 5.1 Pessimistic State Transition Locking
Any state machine event acquires an exclusive row-level lock on the target transaction:
```sql
SELECT * FROM transactions WHERE id = $1 FOR UPDATE;
```
This guarantees that concurrent capture or refund requests are strictly serialized and cannot cause negative balances or double-settlements.

### 5.2 Transactional Advisory Locking for Idempotency
To serialize concurrent requests bearing the exact same idempotency key before any row is inserted:
```sql
SELECT pg_advisory_xact_lock(hashtext('idem_' || $merchantId || '_' || $operation || '_' || $key));
```
PostgreSQL transactional advisory locks automatically release upon `COMMIT` or `ROLLBACK`, eliminating orphan lock leaks.

