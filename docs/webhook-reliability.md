# Webhook Ingestion & Reliability Pipeline

## 1. Pipeline Overview

Payment gateway webhooks are inherently asynchronous, prone to network delays, duplicate deliveries, and out-of-order execution. The ZeTheta platform implements a durable, fault-tolerant ingestion pipeline ensuring guaranteed at-least-once delivery with exactly-once processing semantics.

```mermaid
flowchart TD
    GW["Downstream Gateway<br/>(Razorpay / Stripe / PayU / UPI)"] -->|POST Webhook + HMAC Signature| Ingest["API Webhook Ingestion Endpoint"]
    
    subgraph IngestionStage ["Synchronous Ingestion (< 50ms)"]
        Ingest --> VerifySig{"HMAC Signature Valid?"}
        VerifySig -->|No| Reject401["Reject: HTTP 401 Unauthorized"]
        VerifySig -->|Yes| CheckDedup{"Event Exists in<br/>processed_webhook_events?"}
        CheckDedup -->|Yes (Duplicate)| Ack200Dup["Immediate Ack: HTTP 200 (Duplicate)"]
        CheckDedup -->|No (Novel)| Enqueue["Insert into webhook_queue (status='PENDING')<br/>Insert into processed_webhook_events"]
        Enqueue --> Ack200["Immediate Ack: HTTP 200 (Ingested)"]
    end

    subgraph ProcessingStage ["Asynchronous Worker Processing"]
        Worker["Webhook Background Worker"] -->|Poll: SELECT ... FOR UPDATE SKIP LOCKED| QueueDB[("webhook_queue Table")]
        QueueDB --> ProcessEvent["Dispatch to State Machine"]
        ProcessEvent --> OutcomeCheck{"Transition Success?"}
        OutcomeCheck -->|Success| MarkComplete["UPDATE webhook_queue SET status='PROCESSED'"]
        OutcomeCheck -->|Transient Error| IncAttempt["attempts += 1<br/>next_delivery_at = NOW() + 2^attempts * 30s"]
        IncAttempt --> AttemptCheck{"attempts >= max_retries (5)?"}
        AttemptCheck -->|No| RetryLater["Keep status='PENDING'"]
        AttemptCheck -->|Yes| MoveDLQ["UPDATE webhook_queue SET status='DLQ'"]
    end

    subgraph DLQReplay ["DLQ Management"]
        Admin["Admin User"] -->|POST /api/v1/admin/webhooks/dlq/replay| ReplayAPI["Admin Replay Controller"]
        ReplayAPI --> ResetQueue["UPDATE webhook_queue SET status='PENDING', attempts=0"]
        ResetQueue --> Worker
    end
```

---

## 2. Signature Verification Details

Every incoming webhook request passes through raw-body cryptographic validation before JSON deserialization:

| Gateway | Header | Algorithm | Verification Implementation |
|---|---|---|---|
| **Razorpay** | `x-razorpay-signature` | HMAC-SHA256 | `crypto.createHmac('sha256', secret).update(rawBody).digest('hex')` compared with `crypto.timingSafeEqual` |
| **Stripe** | `stripe-signature` | HMAC-SHA256 (t, v1) | Parses `t=<timestamp>,v1=<signature>`; computes `HMAC(secret, "${t}.${rawBody}")` |
| **PayU** | `hash` | SHA-512 | `crypto.createHash('sha512').update(salt|status|...|key).digest('hex')` |
| **UPI** | `x-upi-signature` | HMAC-SHA256 | `crypto.createHmac('sha256', secret).update(rawBody).digest('hex')` |

Requests with invalid signatures are rejected immediately with HTTP 401 without recording or parsing.

---

## 3. Deduplication Architecture

Downstream gateways often retry webhooks when network acknowledgments lag. To ensure idempotency:
1. When a valid webhook arrives, its `(gateway, event_id)` is checked against `processed_webhook_events`.
2. If already present:
   - Ingestion logs `duplicate=true`.
   - Returns immediate HTTP 200 to acknowledge the gateway.
   - Discards the redundant payload without re-enqueuing.
3. If novel:
   - Inserts record into `processed_webhook_events` within a transaction.
   - Inserts payload into `webhook_queue`.
   - Returns HTTP 200 within $< 50\text{ ms}$.

---

## 4. Worker Leasing & Exponential Backoff

The background daemon worker (`src/workers/webhook.worker.ts`) leases pending queue entries using PostgreSQL's row-level lock skipping:
```sql
SELECT * FROM webhook_queue
WHERE status = 'PENDING' AND next_delivery_at <= NOW()
ORDER BY id ASC
LIMIT 1
FOR UPDATE SKIP LOCKED;
```
This enables multiple worker instances to process the queue concurrently without lock contention or duplicate worker leases.

### Exponential Backoff Formula
If event processing encounters a transient database deadlock or lock conflict, the delivery time is rescheduled exponentially:
$$\text{next\_delivery\_at} = \text{NOW()} + (2^{\text{attempts}} \times 30\text{ seconds})$$

- Attempt 1: $+60\text{s}$
- Attempt 2: $+120\text{s}$
- Attempt 3: $+240\text{s}$
- Attempt 4: $+480\text{s}$
- Attempt 5: Exceeds `max_retries` (5) $\to$ Status escalated to **`DLQ`**.

---

## 5. Dead Letter Queue (DLQ) & Operator Replay

Events that exceed maximum retry attempts are isolated into the Dead Letter Queue (`status = 'DLQ'`).
- **Endpoint:** `GET /api/v1/admin/webhooks/dlq` lists quarantined events for diagnostic inspection.
- **Replay Endpoint:** `POST /api/v1/admin/webhooks/dlq/replay` resets quarantined events back to `PENDING` with `attempts = 0` and `next_delivery_at = NOW()`, permitting safe reprocessing following incident remediation.

