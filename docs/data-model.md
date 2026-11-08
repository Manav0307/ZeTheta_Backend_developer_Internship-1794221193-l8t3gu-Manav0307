# Relational Data Model Specification

## 1. Entity-Relationship Overview

The ZeTheta platform persists financial transactions, routing audits, circuit breaker states, webhooks, and reconciliation records across a fully relational, 3NF schema in PostgreSQL.

```mermaid
erDiagram
    TRANSACTIONS ||--o{ PAYMENT_ATTEMPTS : "has"
    TRANSACTIONS ||--o{ GATEWAY_ROUTES : "evaluated"
    TRANSACTIONS ||--o{ TRANSACTION_STATE_LOG : "audited by"
    TRANSACTIONS ||--o{ CAPTURE_OPERATIONS : "captured via"
    TRANSACTIONS ||--o{ REFUNDS : "refunded via"
    TRANSACTIONS ||--o{ IDEMPOTENCY_KEYS : "scoped by"

    PAYMENT_ATTEMPTS ||--o{ CAPTURE_OPERATIONS : "authorized for"
    PAYMENT_ATTEMPTS ||--o{ REFUNDS : "refunded on"
    PAYMENT_ATTEMPTS ||--o{ TRANSACTION_STATE_LOG : "linked to"

    GATEWAY_CONFIG ||--o{ GATEWAY_CIRCUIT_BREAKERS : "tracks"
    GATEWAY_CONFIG ||--o{ GATEWAY_HEALTH_METRICS : "measures"

    RECONCILIATION_RUNS ||--o{ RECONCILIATION_LOG : "contains"
    RECONCILIATION_RUNS ||--o{ RECONCILIATION_ANOMALIES : "flags"

    TRANSACTIONS {
        uuid id PK
        varchar merchant_id
        varchar merchant_order_id UK
        varchar state
        varchar payment_method
        varchar currency
        numeric amount_minor
        numeric authorized_minor
        numeric captured_minor
        numeric refunded_minor
        numeric reserved_refund_minor
        varchar capture_mode
        integer version
        timestamptz created_at
        timestamptz updated_at
    }

    PAYMENT_ATTEMPTS {
        uuid id PK
        uuid transaction_id FK
        integer attempt_no
        varchar gateway
        varchar status
        numeric amount_minor
        varchar provider_payment_ref
        varchar provider_idempotency_key
        varchar error_class
        varchar error_code
        timestamptz created_at
    }

    TRANSACTION_STATE_LOG {
        bigserial id PK
        uuid transaction_id FK
        uuid attempt_id FK
        varchar from_state
        varchar to_state
        varchar event
        varchar gateway_reference
        jsonb gateway_response
        jsonb metadata
        uuid trace_id
        varchar created_by
        timestamptz created_at
    }

    CAPTURE_OPERATIONS {
        uuid id PK
        uuid transaction_id FK
        uuid attempt_id FK
        varchar operation_key UK
        numeric amount_minor
        varchar status
        timestamptz created_at
    }

    REFUNDS {
        uuid id PK
        uuid transaction_id FK
        uuid attempt_id FK
        varchar refund_key UK
        numeric amount_minor
        varchar status
        varchar reason
        timestamptz created_at
    }

    IDEMPOTENCY_KEYS {
        varchar merchant_id PK
        varchar operation PK
        varchar key PK
        varchar request_hash
        uuid transaction_id FK
        varchar status
        integer response_code
        jsonb response_body
        timestamptz expires_at
    }

    GATEWAY_CIRCUIT_BREAKERS {
        varchar gateway PK
        varchar payment_method PK
        varchar state
        integer consecutive_failures
        timestamptz opened_until
        timestamptz last_probed_at
    }

    PROCESSED_WEBHOOK_EVENTS {
        varchar gateway PK
        varchar event_id PK
        uuid transaction_id FK
        varchar event_type
        timestamptz processed_at
    }

    WEBHOOK_QUEUE {
        bigserial id PK
        varchar gateway
        varchar event_id
        jsonb raw_payload
        varchar status
        integer attempts
        timestamptz next_delivery_at
    }
```

---

## 2. Table Responsibilities & Schemas

### 2.1 `transactions`
- The core aggregate root representing a commercial customer payment order.
- Tracks monetary lifecycle balances in minor currency units (`authorized_minor`, `captured_minor`, `refunded_minor`, `reserved_refund_minor`).
- Guaranteed unique per `(merchant_id, merchant_order_id)`.
- Protected by optimistic locking column `version` and pessimistic row locks (`SELECT ... FOR UPDATE`).

### 2.2 `payment_attempts`
- Records every discrete interaction with a downstream payment gateway.
- Enforces composite uniqueness on `(transaction_id, attempt_no)`.
- Contains partial unique index guaranteeing at most **one active attempt per transaction** at any point in time.

### 2.3 `transaction_state_log`
- Append-only audit ledger of every state transition across the system.
- Captures `from_state`, `to_state`, triggering `event`, actor `created_by`, `trace_id`, and raw gateway responses.
- Protected by PostgreSQL trigger `trg_state_log_immutable` which prevents any modification or deletion.

### 2.4 `gateway_routes`
- Records real-time routing engine evaluations for each payment.
- Stores composite scores and factor breakdowns for all candidates, plus the winning gateway.

### 2.5 `capture_operations` & `refunds`
- Track individual partial/full capture and refund operations.
- Enforce idempotency via unique keys `operation_key` and `refund_key`.
- Foreign keys reference `(attempt_id, transaction_id)` to ensure referential integrity back to the authorized attempt.

### 2.6 `idempotency_keys`
- Stores request fingerprints (SHA-256) and cached HTTP responses.
- Composite primary key on `(merchant_id, operation, key)`.
- Lifecycle managed through PostgreSQL transactional advisory locks.

### 2.7 `gateway_circuit_breakers` & `gateway_health_metrics`
- Dynamic operational health indicators per gateway and payment instrument.
- Tracks consecutive failures, recovery cooldown timestamps, and 24-hour rolling success rates.

### 2.8 `processed_webhook_events` & `webhook_queue`
- Asynchronous webhook deduplication and durable retry buffer.
- Events verified by HMAC signature are registered in `processed_webhook_events` and enqueued in `webhook_queue`.
- Leased workers pop events with exponential backoff and dispatch them to the state machine.

### 2.9 `reconciliation_runs`, `reconciliation_log`, & `reconciliation_anomalies`
- Records automated batch reconciliation passes.
- Tracks examined transactions, corrected states, and flagged anomalies.

