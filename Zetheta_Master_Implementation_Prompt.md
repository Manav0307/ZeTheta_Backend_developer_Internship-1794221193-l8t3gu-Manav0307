# MASTER CODING-AGENT IMPLEMENTATION SPECIFICATION
## Zetheta — Payment Orchestration Layer with Multi-Gateway Failover

> **Intended audience:** Codex or another autonomous software-engineering agent operating inside a Git repository.
> **Source of truth:** `Zetheta_Backend_project.pdf`, **Part A only**, printed pages **3–23** (PDF pages 3–23). The executive summary on printed pages 1–2 provides context, not an expansion of Part A. Do **not** infer or import requirements from Parts B–F unless the human later authorizes that scope.
> **Deliverable:** A real, runnable, well-tested backend codebase with README, architectural documentation, OpenAPI specification, migrations/seeds, automated tests, and reproducible local setup.
> **Scope guardrail:** This specification combines (a) explicitly required information from the PDF and (b) **proposed implementation decisions** made for this project. Those two categories are explicitly labeled. If they conflict, honor the PDF's functional intent and call out the conflict in documentation rather than silently deviating.

---

# 0. AGENT OPERATING INSTRUCTIONS (READ FIRST)

You are a senior backend/payment systems engineer and critical reviewer. Implement the project end-to-end in the current working repository. Do not stop after scaffolding, making a plan, adding interfaces, generating mock API responses, or writing superficial tests. Take ownership of design, coding, database migrations, fixture generation, running automated checks, and documentation.

1. **Inspect the repository first.** Identify existing files, installed dependencies, project conventions, and available tools. Preserve existing useful work. If starting empty, scaffold the technology stack in §2.
2. **Inspect the source PDF if present** and cross-check all obligations with Part A (printed pages 3–23). Do not use other parts of the PDF for requirements. If PDF is unavailable, implement against this specification and document that verification against the PDF was not performed.
3. **Maintain `docs/requirements-traceability.md`:** every requirement must list the PDF page/section, implementation location, and verification test. Separate `[PDF]` from `[DESIGN]` requirements.
4. **Use a modular monolith, not microservices.** An API process and separately runnable worker processes can share one repository and its modules.
5. **Prioritize correctness:** no double charges, no invalid state transitions, no lost acknowledged webhooks, no unsafe failover, no false payment success, no floating-point payment arithmetic, no missing financial audit entries.
6. **Do not silently assume live provider support.** Provide deterministic mock adapters that simulate gateway behavior, and optional real sandbox adapters only where legitimately available. Never request, commit, or fabricate real API credentials.
7. **Do not misrepresent outcomes.** A gateway timeout is an *unknown* result, not evidence of failure. Never retry a possibly executed charge with a different gateway without first proving it is safe.
8. **Use provider docs for actual production/sandbox integration specifics** if internet/provider docs are available. PDF gateway limits, capabilities, fee rates, settlement cycles and signature summaries are project test fixtures/assumptions unless separately verified. Record any differences.
9. **Execute tests and report actual results.** If something cannot be tested (e.g., real UPI NPCI integration without authorization), state this explicitly in `docs/limitations.md`.
10. **Do not claim “production ready,” “PCI compliant,” “RBI compliant,” or “zero defects.”** Demonstrate production-oriented engineering and identify what would be needed for a true payment-provider production rollout.
11. **No nonessential frontend.** Swagger UI and Postman-compatible examples suffice; add no React app unless all required backend functionality is complete.
12. **Continue implementation through all mandatory features** before adding optional improvements. At the end, provide a concise completion report: implemented modules, migration commands, test output, outstanding limitations, and where each requirement is satisfied.

## Definition of done

The entire application boots locally using documented commands; PostgreSQL migrations and seeds run cleanly; APIs behave according to OpenAPI; mock gateways exercise success, failure, and timing behaviors; at least 23 prescribed routes are implemented; financial state transitions are validated and audited; the webhook queue handles duplicates and crash/retry scenarios; reconciliation actually polls and compares outcomes; rate limits and circuit breakers work; and automated integration and failure tests run against a real test PostgreSQL instance. No `TODO`, fake-success response, unimplemented handler, skipped required test, or broad catch-and-ignore block may be counted as done.

---

# 1. PROJECT MISSION AND BOUNDARIES

## [PDF] Project purpose

Build an orchestrator *between a merchant backend and gateways* for Razorpay, Stripe, PayU and UPI routes. The orchestrator manages intelligent gateway selection, two-phase auth/capture where supported, deterministic transaction lifecycles, idempotency, gateway-specific health/circuit breakers, safe failover, signed webhook ingestion, deduplication, reconciliation, audit trails, configurable routing and outbound rate limiting.

Project context assumes a fictional merchant platform with 100,000+ payments/day. The source sets a **2-second recovery/failover target**; measure this specifically for conditions where failover is confirmed safe, rather than implying this is possible for all unknown-outcome network timeouts.

**Out of scope for Part A:** real payment acquiring agreements, acting as an NPCI participant, collecting card PAN/CVV, an e-commerce storefront, a production secrets vault/payment compliance certification, multi-region active-active infrastructure, message broker clusters, and live financial settlement. The project still needs sensible security controls and accurate simulations.

## Core architecture

```text
Merchant/Test Client
  |  REST JSON + Idempotency-Key + merchant auth
  v
Express API (TypeScript, Zod, request tracing, error normalization)
  |
  +-- Payment Application Service
  |     +-- Idempotency Manager (PostgreSQL unique keys + transactions)
  |     +-- Transaction FSM (allowed transitions + immutable audit)
  |     +-- Gateway Router (eligible gateways, weighted scoring)
  |     +-- Circuit Breaker (gateway × payment method)
  |     +-- Outbound Rate Limiter (gateway-specific)
  |     +-- Adapter Registry
  |           +-- Razorpay adapter (mock + optional sandbox)
  |           +-- Stripe adapter (mock + optional sandbox)
  |           +-- PayU adapter (mock + optional sandbox)
  |           +-- UPI adapter (mock/authorized aggregator integration only)
  |
  +-- Webhook HTTP Receivers
  |     +-- Raw-body Signature Verification
  |     +-- Atomic Deduplication + Durable Queue Insert
  |     +-- Webhook Worker -> FSM + audit + event completion
  |     +-- Retries / DLQ / manual replay
  |
  +-- Reconciliation API + Periodic Worker
  |     +-- Find stale/uncertain payment attempts
  |     +-- Fetch authoritative gateway status
  |     +-- Compare + audit + anomalies / safe corrective transitions
  |
  +-- Gateway Health/Metrics/Analytics API
  |
  +-- PostgreSQL (durable source of truth)
  +-- Structured JSON Logs (trace_id, transaction_id)

External mocked/sandbox gateways -> webhook endpoints
```

### [DESIGN] Critical structural decision

Use one `transactions` row per logical merchant payment **plus separate `payment_attempts` rows** per gateway attempt. Never overwrite historical gateway attempt IDs when failing over. `gateway_routes` records every route decision and scoring explanation. This is essential to correlate delayed callbacks and avoid double charging across alternate gateways.

---

# 2. STACK AND ENGINEERING CONVENTIONS

| Layer | Choice | Status |
|---|---|---|
| Runtime | Current supported Node.js LTS | [DESIGN] |
| Language | TypeScript, strict mode | [DESIGN] |
| HTTP API | Express.js | [DESIGN] |
| Validation | Zod | [DESIGN] |
| Primary durable storage | PostgreSQL | [PDF] mandatory |
| SQL access | `pg` (`node-postgres`), parameterized SQL | [DESIGN] |
| Schema migration | Knex migrations, Knex CLI, optionally raw SQL | [DESIGN] |
| HTTP client | Native `fetch`/undici with AbortController and timeouts | [DESIGN] |
| API documentation | OpenAPI 3.0 + Swagger UI | [PDF] mandatory standard |
| Persistent webhook queue | PostgreSQL queue table with `FOR UPDATE SKIP LOCKED` | [DESIGN], fulfilling [PDF] durable queue |
| Scheduled reconciliation | Dedicated worker with interval scheduling or `node-cron` | [DESIGN] |
| Tests | Vitest + Supertest + PostgreSQL integration tests | [DESIGN] |
| Logging | Pino JSON logs | [DESIGN] fulfilling [PDF] JSON traces |
| Local runtime | Docker Compose for app/worker/Postgres, no Redis dependency | [DESIGN] |
| Version control | Git/GitHub | [PDF] overall task context |

**Do not introduce Redis, Kafka, RabbitMQ, Kubernetes, React or a separate microservice deployment as dependencies for basic functionality.** They are optional alternatives, not Part A mandates. If PostgreSQL persistence is the default queue, PostgreSQL `LISTEN/NOTIFY` may only *wake* consumers; notifications must never be the sole durable queue.

### Quality conventions

- `tsconfig` strict, `noUncheckedIndexedAccess` if practical, lint/formatter, explicit typed DTOs, no unsafe `any` at external boundaries.
- All input validation is schema-based. Reject unknown/invalid amounts, currencies, states, payloads, excessive body sizes, or malformed IDs; return consistent errors.
- All monetary amounts are stored in integer **minor units** (e.g., INR paise) as PostgreSQL `BIGINT` or `NUMERIC(15,2)` consistently. Prefer `BIGINT` and represent amounts as validated integer strings at JS/JSON boundaries to avoid JavaScript number precision loss. Include currency; do not assume every currency has two minor digits. Tests for INR can use 2 digits.
- Use UTC `TIMESTAMPTZ`, immutable event timestamps, and UUID identifiers; use timezone-aware formatting.
- No database transactions around outbound HTTP requests. Use short atomic DB transactions before and after calls.
- Stable error codes and retry classifications, no raw gateway messages/sensitive fields reflected to end users.
- Secrets from environment variables only, fail closed in non-mock deployments, ship `.env.example` without real credentials.
- Separate merchant/admin API auth from gateway webhook verification. Use an API key for local demo (hashed or verified using constant-time comparisons) and role-guard config/admin routes. Document this is demonstrative, not full production IAM.
- Limit log payload fields; redact tokens, card details, personal data, raw webhook secrets, and authentication headers.

---

# 3. EXACT REQUIRED API SURFACE — PART A §A7 (PRINTED PAGES 18–19)

All endpoints have prefix `/api/v1`. Implement exactly these 23 prescribed operations; additional admin/DLQ endpoints may be added and documented.

| # | Verb | Endpoint | Required behavior |
|---:|---|---|---|
| 1 | POST | `/payments` | Initiate payment with idempotency |
| 2 | GET | `/payments/:id` | Retrieve payment/current state and sanitized attempt data |
| 3 | GET | `/payments?merchant_order_id=:id` | Find by merchant order ID; enforce proper scoping |
| 4 | POST | `/payments/:id/capture` | Capture authorized payment, allow partial if supported |
| 5 | POST | `/payments/:id/void` | Void authorized hold |
| 6 | POST | `/payments/:id/refund` | Start full or partial refund if captured balance permits |
| 7 | GET | `/payments/:id/refunds` | List refunds and lifecycle |
| 8 | GET | `/payments/:id/timeline` | Immutable state-transition trail |
| 9 | POST | `/webhooks/razorpay` | Verify and enqueue signed Razorpay event |
| 10 | POST | `/webhooks/stripe` | Verify and enqueue signed Stripe event |
| 11 | POST | `/webhooks/payu` | Verify and enqueue signed PayU event |
| 12 | POST | `/webhooks/upi` | Verify and enqueue UPI/aggregator callback |
| 13 | GET | `/gateways` | List configured gateway capabilities/status |
| 14 | GET | `/gateways/:name/health` | Per-method breaker/health status |
| 15 | GET | `/gateways/:name/metrics` | Success rate, latency P95, volume, recent errors |
| 16 | PUT | `/gateways/:name/config` | Authenticated configuration updates |
| 17 | GET | `/routing/config` | Current routing weights and thresholds |
| 18 | PUT | `/routing/config` | Validate/update weights; immediately used by router |
| 19 | POST | `/reconciliation/trigger` | Authorized manual run or enqueue; report run ID |
| 20 | GET | `/reconciliation/reports/:run_id` | Retrieve discrepancies, changes and anomalies |
| 21 | GET | `/analytics/success-rate` | Success-rate analytics over a validated time range |
| 22 | GET | `/analytics/volume` | Payment volume analytics over a validated time range |
| 23 | GET | `/health` | API and database liveness/readiness summary |

Implementation notes:

- OpenAPI **3.0.x** must document *all* routes, JSON requests/responses, errors, headers, and examples; serve `/docs` and a machine-readable schema endpoint.
- `Idempotency-Key` is mandatory on state-changing **merchant payment operations** (`payments`, capture, void, refund); keep operation-scoped idempotency keys so the same key cannot accidentally alias different operations. Webhook ingestion uses provider event IDs instead.
- Merchant API should return `201`/`202`/`200` appropriately according to actual final/pending behavior; `409` when same key is already actively processing and cannot yet provide an equivalent result; `422` for invalid state/unsupported method; `429` when relevant backpressure occurs; `503` for unavailable dependencies; and stable normalized JSON errors.
- State-changing operations should accept a request/trace ID and persist a normalized response for idempotent repeat calls.
- On unknown external outcomes, respond with `PENDING` or equivalent uncertain state and a stable payment ID. Do not claim failure or success prematurely.
- Access controlled analytics and configuration routes; sanitize details.
- Health must distinguish liveness from readiness and not report healthy when the database is unreachable.

### [DESIGN] Example API payload contracts

Create payment:

```json
{
  "merchant_order_id": "order_1001",
  "amount_minor": "500000",
  "currency": "INR",
  "payment_method": "CARD",
  "capture_method": "MANUAL",
  "metadata": { "source": "demo" }
}
```

Suggested response (actual fields depend on state):

```json
{
  "id": "<payment UUID>",
  "merchant_order_id": "order_1001",
  "amount_minor": "500000",
  "currency": "INR",
  "state": "AUTH_INITIATED",
  "selected_gateway": "razorpay",
  "next_action": null,
  "trace_id": "<UUID>"
}
```

A card payment may require a hosted payment page/tokenization/redirect and cannot be fully authorized using only this payload in a real gateway. **For mock mode**, simulate token/approval actions without sensitive card data. Document gateway-specific `next_action` steps for future sandbox adapters.

Standard error shape (from PDF §A7.2, adjusted to avoid disclosing sensitive provider responses):

```json
{
  "error": {
    "code": "PAYMENT_AUTH_FAILED",
    "message": "Payment authorisation was declined.",
    "details": {
      "gateway": "razorpay",
      "gateway_error_code": "NORMALIZED_DECLINE",
      "suggestion": "Use a different payment method or contact your bank."
    },
    "request_id": "<UUID>",
    "timestamp": "<UTC ISO-8601>"
  }
}
```

For all 23 APIs, write request/response tests including invalid payloads, authorization, negative cases, and standard errors.

---

# 4. TRANSACTION FSM — PART A §A2 (PRINTED PAGES 5–7)

### [PDF] Minimum required named states

`CREATED`, `ROUTE_SELECTED`, `AUTH_INITIATED`, `AUTHORISED`, `AUTH_FAILED`, `CAPTURE_INITIATED`, `CAPTURED`, `PARTIALLY_CAPTURED`, `CAPTURE_FAILED`, `REFUND_INITIATED`, `REFUNDED`, `FAILED`.

### [PDF] Additional useful named states

`ABANDONED`, `VOID_INITIATED`, `VOIDED`, `AUTH_EXPIRED`, `SETTLED`, `PARTIALLY_REFUNDED`, `REFUND_FAILED`, `DISPUTE_OPENED`, `DISPUTE_RESOLVED`, and `ROUTE_FAILED`, `AUTH_TIMEOUT` where needed. **The PDF has inconsistencies**: its “valid outgoing events” sometimes list a *state* rather than an event, and the minimum 12 omit states referenced by their transition lists. Resolve with explicit typed transition events and document mapping in `docs/state-machine.md`.

### [DESIGN] Recommended formal transition model

State transitions must be guarded by an event, current state, payment attempt state, cumulative captured/refunded amounts, and available gateway capabilities. Suggested transitions:

```text
CREATED              --select_route-----------> ROUTE_SELECTED
CREATED              --abandon----------------> ABANDONED
ROUTE_SELECTED       --begin_auth-------------> AUTH_INITIATED
ROUTE_SELECTED       --route_exhausted--------> ROUTE_FAILED
AUTH_INITIATED       --auth_succeeded---------> AUTHORISED
AUTH_INITIATED       --auth_declined----------> AUTH_FAILED
AUTH_INITIATED       --auth_outcome_unknown---> AUTH_TIMEOUT
AUTH_FAILED          --safe_reroute-----------> ROUTE_SELECTED
AUTH_FAILED          --nonretryable/exhausted-> FAILED
AUTH_TIMEOUT         --reconciled_success-----> AUTHORISED
AUTH_TIMEOUT         --reconciled_failure-----> AUTH_FAILED
AUTH_TIMEOUT         --verified_safe_reroute--> ROUTE_SELECTED
AUTHORISED           --begin_capture----------> CAPTURE_INITIATED
AUTHORISED           --begin_void-------------> VOID_INITIATED
AUTHORISED           --hold_expired-----------> AUTH_EXPIRED
CAPTURE_INITIATED    --capture_complete-------> CAPTURED
CAPTURE_INITIATED    --capture_partial--------> PARTIALLY_CAPTURED
CAPTURE_INITIATED    --definite_capture_error-> CAPTURE_FAILED
PARTIALLY_CAPTURED   --capture_remainder------> CAPTURE_INITIATED
PARTIALLY_CAPTURED   --begin_refund-----------> REFUND_INITIATED
PARTIALLY_CAPTURED   --settlement_confirmed--> SETTLED
CAPTURE_FAILED       --retry_safe_capture-----> CAPTURE_INITIATED
CAPTURE_FAILED       --begin_void-------------> VOID_INITIATED
CAPTURED             --begin_refund-----------> REFUND_INITIATED
CAPTURED             --settlement_confirmed--> SETTLED
SETTLED              --begin_refund-----------> REFUND_INITIATED
REFUND_INITIATED     --partial_refund_done----> PARTIALLY_REFUNDED
REFUND_INITIATED     --full_refund_done-------> REFUNDED
REFUND_INITIATED     --definite_refund_error--> REFUND_FAILED
PARTIALLY_REFUNDED   --additional_refund------> REFUND_INITIATED
REFUND_FAILED        --retry_safe_refund------> REFUND_INITIATED
VOID_INITIATED       --void_succeeded---------> VOIDED
```

These are **proposed transitions**, not a literal canonical transition table from the PDF. Add other justified transitions for void failure, settlement, disputes and delayed/out-of-order events. Do not silently invent transitions: enumerate them with code-enforced guards and tests. Where aggregate transaction state cannot represent simultaneous sub-operations (e.g., refund pending while settled), **use separate typed `payment_attempts`, `captures` (if required), and `refunds` lifecycle records** and derive an accurate aggregate summary. Do not blindly regress a final state on stale webhooks.

### [DESIGN] Important FSM invariants

- No refund until captured balance exists; sum of successful/pending refunds cannot exceed captured amount.
- No capture above authorized/capturable balance; cumulative captures cannot exceed authorized amount.
- “Captured” and “settled” must not be conflated; settlement status may need independent tracking after refund initiation.
- Every real state change is atomic with its `transaction_state_log` insert in one DB transaction.
- Illegal transition -> typed domain error; must not write invalid state.
- Serialize concurrent modifications via `SELECT ... FOR UPDATE` on the logical payment (or compare-and-swap versioning where justified).
- Do not hold locks during gateway calls.
- Handle delayed/out-of-order webhook events with event-time/state checks, direct gateway status queries, and a record of ignored or pending events; a stale event must not overwrite newer confirmed state.
- If a gateway reports an outcome contradicted by an already confirmed financial fact, log an anomaly and require reconciliation/human review rather than silently reversing funds.
- Always use immutable audit rows (append-only) for state changes, with source actor (`api`, `webhook_worker`, `reconciliation_worker`, etc.), from/to, event, reason, gateway attempt ID, trace ID, and redacted payload metadata.

---

# 5. POSTGRESQL DATA MODEL — PART A §A6 (PRINTED PAGES 16–17)

### [PDF] Ten required tables

1. `transactions`: logical payment and current state.
2. `transaction_state_log`: immutable audit trail.
3. `gateway_routes`: chosen gateway, time, score and reasons.
4. `idempotency_keys`: key, SHA-256 request hash, status, cached response, expiration.
5. `processed_webhook_events`: dedup by compound key `(gateway,event_id)`.
6. `gateway_health_metrics`: per-minute gateway and payment-method metrics.
7. `reconciliation_log`: reconciliation results, discrepancies, actions.
8. `refunds`: refund lifecycle and amounts.
9. `gateway_config`: gateway connectivity, feature flags, capabilities and fee config.
10. `routing_config`: routing weights, thresholds, routing strategy configuration.

### [DESIGN] Additional necessary/beneficial tables

11. `payment_attempts`: one row per provider attempt with unique attempt ID, gateway, provider reference, attempt status (`CREATED`/`SENT`/`UNKNOWN`/`SUCCEEDED`/`FAILED`), started/completed timestamps, failure classification, idempotency reference, trace ID.
12. `webhook_queue`: durable event payload/envelope, signature verification metadata, queue status, retries, schedule, error and DLQ status (explicitly described in PDF §A8.3).
13. `gateway_circuit_breakers`: `(gateway,payment_method)` breaker state, counters, open-until and half-open lease.
14. `reconciliation_anomalies`: severity, discrepancy, status and action tracking.
15. `reconciliation_runs`: run metadata, status, counts, start/end and trigger source, with `reconciliation_log` referencing run ID.
16. `capture_operations` (if needed to accurately model multi/partial capture and unknown outcomes) and `outbound_gateway_calls` (if needed for safer attempt tracing).

### Schema principles

- Produce real migrations with PKs/FKs/unique constraints/check constraints and indexes. Use `UUID` PKs where applicable.
- `transactions`: unique `(merchant_id,merchant_order_id)` according to merchant isolation rules; amount minor units `BIGINT > 0`, currency, payment method, capture mode, state, authorized/captured/refunded minor units, selected active attempt, trace ID, timestamps, version.
- `gateway_routes`: include raw inputs (success rate, latency, transaction cost, health, fit), normalized values, chosen scores, config version, and selection rationale; never erase previous decisions.
- `idempotency_keys`: unique composite `(merchant_id,operation,key)` or equivalent scoped key; `request_hash` and associated `transaction_id`, `PROCESSING|COMPLETED|FAILED|UNKNOWN`, stored status code/JSON, `expires_at`, timestamps. PDF minimum shows `PROCESSING|COMPLETED|FAILED`; **the extra `UNKNOWN` status is a reasoned safety extension** to prevent unsafe reissue after ambiguous external results. Record this departure in traceability.
- `processed_webhook_events`: `PRIMARY KEY(gateway,event_id)`, payload hash, transaction link, event type, timestamps, processing outcome or queue ID.
- `webhook_queue`: explicit `PENDING|PROCESSING|COMPLETED|FAILED|DLQ`, `retry_count`, `max_retries=3`, `next_retry_at`, error, timestamps; use worker leases/heartbeats or stale-lease recovery for crashes.
- `transaction_state_log`: insert-only by app permissions/policy; optionally DB trigger to forbid UPDATE/DELETE; redact provider response before storage. Add `trace_id` beyond the PDF example for §A8.5.
- `gateway_health_metrics`: indexes on `(gateway,payment_method,recorded_at)`; payment method dimension needed for per-method breakers.
- `refunds`: unique provider refund reference if present and unique request idempotency; cumulative amount checks inside transaction.
- Gateway secret keys must **not** live in plaintext in `gateway_config`. Store provider name and a secret reference; read secret from environment/secret manager.
- All JSONB contains sanitized data only. No raw PAN/CVV, authorization tokens, UPI PIN, or sensitive personal payment details.
- For webhook dedup, ensure queue insertion and event claim are committed atomically; a crash cannot yield a permanent “processed” marker without queued/durable work.

### Migration/seed requirements

- `npm run db:migrate`, `npm run db:rollback`, `npm run db:seed` are idempotent/reproducible in documented context.
- Seed default routing weights from PDF: success **0.35**, latency **0.20**, cost **0.20**, health **0.15**, payment method fit **0.10**.
- Seed circuit breaker example defaults: **5 consecutive qualified failures**, **30 seconds OPEN**, controlled **one** half-open test request; config changeable without redeployment.
- Seed historical gateway performance dataset **exactly as on page 10**:

| Gateway | Time band | Success | P95 ms | Transactions | Fee % + fixed INR |
|---|---|---:|---:|---:|---|
| Razorpay | 00–06 | 98.5% | 320 | 4,200 | 2.0% + ₹2 |
| Razorpay | 06–12 | 97.2% | 450 | 18,500 | 2.0% + ₹2 |
| Razorpay | 12–18 | 94.1% | 780 | 32,000 | 2.0% + ₹2 |
| Razorpay | 18–24 | 96.8% | 520 | 25,300 | 2.0% + ₹2 |
| Stripe | 00–06 | 99.1% | 280 | 3,800 | 2.5% + ₹3 |
| Stripe | 06–12 | 98.8% | 310 | 15,200 | 2.5% + ₹3 |
| Stripe | 12–18 | 97.5% | 420 | 28,500 | 2.5% + ₹3 |
| Stripe | 18–24 | 98.2% | 350 | 22,100 | 2.5% + ₹3 |
| PayU | 00–06 | 96.0% | 400 | 2,100 | 1.8% + ₹1.5 |
| PayU | 06–12 | 93.5% | 620 | 9,800 | 1.8% + ₹1.5 |
| PayU | 12–18 | 89.2% | 950 | 15,500 | 1.8% + ₹1.5 |
| PayU | 18–24 | 91.8% | 750 | 12,200 | 1.8% + ₹1.5 |
| UPI | 00–06 | 99.5% | 180 | 5,600 | 0.0% + ₹0 |
| UPI | 06–12 | 99.2% | 210 | 22,000 | 0.0% + ₹0 |
| UPI | 12–18 | 98.0% | 350 | 38,000 | 0.0% + ₹0 |
| UPI | 18–24 | 98.8% | 250 | 30,500 | 0.0% + ₹0 |

These are **training-fixture numbers**, not authoritative current pricing or provider limits. Include a clean seed path and unit tests proving values.

---

# 6. INTELLIGENT ROUTER — PART A §A3 (PRINTED PAGES 8–10)

For any payment:

1. Load active configuration and constraints: currency, payment method, capture/refund support, feature flags, provider availability, merchant constraints, and gateway capability matrix.
2. **Exclude ineligible gateways before scoring.** A fit score of 0 must not accidentally permit an unsupported method to win.
3. Load rolling gateway statistics: recent captured success count/total (per-minute sliding window), P95 authorization latency, per-provider transaction fee (`percent * amount + fixed`), per-method breaker health.
4. Normalize each factor and calculate:

```text
score(g) =
  W_success * normalized_success_rate(g)
  + W_latency * (1 - normalized_latency(g))
  + W_cost * (1 - normalized_cost(g))
  + W_health * health_score(g)
  + W_fit * fit_score(g, payment_method)

health_score: CLOSED/healthy=1.0; HALF_OPEN/degraded=0.5; OPEN/down=0.0
fit_score: supported=1.0; unsupported=0.0 (but unsupported is excluded)
```

5. `NormalizedSuccessRate = success_count / total_count` when sufficiently sampled. Define/document deterministic cold-start fallback when denominator=0, e.g., use seeded prior and confidence floor.
6. `NormalizedLatency = (p95 - min_p95) / (max_p95 - min_p95)`; same for cost. **Handle zero denominator** (identical competitor values) deterministically (e.g., neutral 0.0 for both disadvantage terms) without NaN.
7. If selected candidate is `HALF_OPEN`, PDF specifies favoring the second-ranked healthier candidate unless score difference exceeds 20%. **Document explicitly how percentage difference is calculated**, and ensure half-open probe lease requirements are respected. Do not route normal traffic through a half-open gateway without acquiring the permitted probe slot.
8. Choose highest eligible score, stable deterministic tie-break (e.g., configured priority then gateway ID), store every candidate score and decision in `gateway_routes` with config version and trace ID.
9. Expose configurable weights with strict validation: all between 0 and 1, sum=1 within documented tolerance, transactions never use partial/stale config updates.
10. Success-rate denominators must distinguish hard declines (insufficient funds, issuer decline) from infrastructure health failures for circuit breaking; evaluate captured success separately from infra health.

### Routing tests

- Exact sample fixture selections for chosen amount/method/hour; assert score computations and audit rationale.
- When fees differ in fixed and percentage components, scores change with amount.
- Unsupported method always excluded; OPEN breaker always excluded.
- HALF_OPEN selection follows documented 20% rule and probe constraints.
- Same measurements → deterministic selection.
- All P95 values/costs equal → no division-by-zero.
- Zero traffic / empty time window → deterministic documented fallback.
- Changing config weights via API changes subsequent selection without restarting service.

---

# 7. GATEWAY ADAPTERS AND FAILOVER — PART A §A1, §A3

Use an interface conceptually like:

```ts
interface PaymentGateway {
  name: 'razorpay' | 'stripe' | 'payu' | 'upi';
  capabilities: GatewayCapabilities;
  authorize(input: AuthorizationInput): Promise<GatewayOutcome>;
  capture(input: CaptureInput): Promise<GatewayOutcome>;
  void(input: VoidInput): Promise<GatewayOutcome>;
  refund(input: RefundInput): Promise<GatewayOutcome>;
  fetchPaymentStatus(input: GatewayStatusQuery): Promise<GatewayStatus>;
  verifyWebhook(rawBody: Buffer, headers: Record<string, unknown>): VerifiedGatewayEvent;
}
```

Refine signatures to model unsupported operations safely, as UPI instant payment does not always expose auth/capture split. Define normalized errors:

- **Hard decline**: issuer insufficient funds/denial/fraud block -> no automatic gateway hopping or reattempt of the same payment instrument.
- **Definite transient pre-execution failure**: gateway rejected/failed before charge execution -> safe alternate routing if policy and time budget permit.
- **Rate-limited**: honor `Retry-After`, queue/backpressure, do not blindly trip breaker.
- **Unknown-outcome timeout**: payment may have executed -> mark attempt `UNKNOWN`, poll/reconcile, and DO NOT charge via alternate gateway until original outcome is conclusively failed/canceled.
- **Capture/refund unknown**: same strict rule; never duplicate non-idempotent financial operations.

### Failover time target

- Source target: failover/recovery **within 2 seconds** for eligible gateway failures.
- Measure from qualification of definite failure to successful alternative routing initiation/result as appropriate; report precise metric semantics, test setup and measured percentile.
- The PDF's failure table also mentions `<500 ms` for direct merchant-to-gateway network failures and `1–2 seconds` for gateway internal errors. These are objectives/illustrations, not blanket guarantees.
- Do not claim a 2-second result if external provider APIs or unresolved outcomes make it impossible.
- Set bounded per-attempt HTTP timeouts. Use cancellation and circuit-breaker guardrails; exponential backoff **with jitter** for safe retries only.
- Never retry issuer declines, insufficent funds, fraud decline, or ambiguous side-effecting operations without provider-supported same-operation idempotency.

### Provider-specific assumptions

PDF §A1.3 gives simplified support, webhook signatures, retry periods, settlements, limits and costs. Implement mocks according to a separately documented **fixture capability matrix**, but actual production adapters must follow current provider documentation. UPI requires an authorized aggregator/PSP route; a standalone public NPCI gateway integration cannot be assumed. Mock-only capabilities must be explicitly labeled.

### Deterministic mock providers

Make mock adapter behavior controllable by **test-only** options (not publicly exposed unsecured): `success`, `hard_decline`, `definite_5xx`, `timeout_before_execution`, `timeout_after_execution`, `delayed_success`, `capture_failure`, `partial_capture`, `refund_failure`, `duplicate_webhooks`, `out_of_order_webhooks`, `invalid_signature`, `health_degradation`, `429_retry_after`. Expose mock status lookups matching previously simulated execution, not newly fabricated outcomes. Generate stable provider IDs and provider event IDs; support replaying events.

---

# 8. IDEMPOTENCY — PART A §A4 (PRINTED PAGES 11–12)

### Required behavior

1. Merchant supplies unique `Idempotency-Key` (UUID recommended).
2. Hash a **canonicalized, validated** request payload with SHA-256, include operation and merchant scoping.
3. In one short transaction, acquire lock/claim key with PostgreSQL unique constraint or transaction advisory lock. Concurrent duplicate cannot perform side effect.
4. If key exists with a **different hash**, return `409` with `IDEMPOTENCY_KEY_REUSED`.
5. If already completed, return exactly cached status/body (possibly include trace headers consistently).
6. If still processing, `409`/in-progress response with stable payment identifier and documented retry guidance; no extra financial operation.
7. Store final response/error classification, transaction reference and timestamps durably.
8. 24-hour expiry is in the PDF, but **do not automatically permit reuse to double-charge the same merchant order after expiry**; unique merchant/order/payment intent protection remains persistent. Cleanup must not break financial deduplication.
9. On external ambiguous failure, key remains bound to same operation and attempt. Retry must query/recover original outcome or reuse provider idempotency token; never create second charge.
10. All side-effecting endpoints (auth creation, capture, void, refund) must have operation-specific idempotency and outbound provider idempotency where supported.

### Concurrency requirements

- Test 2–100 simultaneous identical requests: exactly one logical transaction, one external operation and stable repeat response/409 while in flight.
- Test same key/different bodies, different merchants, expired key with same order, retry after database crash, gateway timeout-after-execution and client disconnect.
- PostgreSQL `pg_advisory_xact_lock(hashtext('idem_' || key))` is an illustrative source pattern, but unique DB constraints are the final authority; avoid relying on 32-bit hashes for uniqueness.

---

# 9. WEBHOOK INGESTION, DEDUP, QUEUE AND DLQ — PART A §A5, §A8.3

### API ingestion path

```text
Provider HTTP POST
  -> raw body capture (before JSON parser mutates content)
  -> provider-specific signature and timestamp/replay verification
  -> parse, validate provider envelope + normalize event
  -> one DB transaction:
       INSERT processed_webhook_events (gateway,event_id) ON CONFLICT ...
       INSERT webhook_queue (..., PENDING)
     COMMIT
  -> acknowledge HTTP 2xx only once event is durably accepted
```

- **Verify signatures on exact raw bytes.** For HMAC comparisons, decode encodings correctly, verify equal length and use `crypto.timingSafeEqual`; never re-JSON-stringify a parsed body before calculating signature.
- Stripe signature handling must use timestamp tolerances per actual provider library; a plain HMAC check is insufficient.
- PayU and UPI signature validation vary by provider/integration; in mock mode implement a **clearly specified test signer/verifier**. Real UPI/NPCI credentials/signature certificates are not available without authorization.
- Duplicate `(gateway,event_id)` -> acknowledge without double-applying; persist payload hash and flag collisions if same event ID arrives with a different body hash.
- If database unavailable prior to commit -> fail HTTP request (e.g., 503), allowing provider delivery retry; never acknowledge unsaved event.
- Acknowledgment occurs after durable enqueue, **not** after full worker execution. Thus dedup insert + enqueue is atomic; worker process + audit/state + processed status update are atomic when possible.

### Queue worker

- Workers claim rows in transactions using `FOR UPDATE SKIP LOCKED`, set `PROCESSING` with lease expiry and attempt count, then commit; never hold row lock while doing long external work.
- Process normalized event; validate cross-reference to merchant/payment attempt/provider reference; apply proper FSM transition only if admissible; record audit and processed status atomically.
- Re-delivery after worker crash is safe; worker can recover stale leases and reprocess idempotently.
- On retriable error, exponential backoff + jitter, up to **3 retries** as document default; after exhaustion mark `DLQ` with error classification.
- DLQ depth > 0 appears in health/metrics/alerting (a log/monitor alert is acceptable locally); implement secured list/detail/replay endpoint such as `GET /api/v1/admin/dlq` and `POST /api/v1/admin/dlq/:id/replay`.
- Keep record of intentionally ignored stale event, unresolved unknown event, and replay attempts.
- Out-of-order and delayed webhook processing must not regress confirmed financial state.
- A single event may refer to auth, capture, refund, dispute; route to correct entity.

### Webhook tests

- Valid signature accepted, invalid signature rejected, tampered payload rejected, replay outside timestamp accepted-window rejected where supported.
- Same event delivered 10x concurrently -> one effect and one unique event row.
- Different gateways same event ID -> separate events.
- Event ID reused with different hash -> flagged.
- Worker crashes after claim -> lease recovery; crashes after commit -> no duplicate effect.
- Out-of-order capture/auth callbacks, delayed refund callbacks, missing transaction references, invalid payload, unrecognized event type, three retries to DLQ, authorized manual replay.
- Database failure must not result in HTTP 200.

---

# 10. RECONCILIATION — PART A §A5.5 (PRINTED PAGE 15)

- Default schedule **every 15 minutes**, configurable.
- Identify attempts stuck in `AUTH_INITIATED`, `AUTH_TIMEOUT`, `CAPTURE_INITIATED` or other uncertain state beyond configured threshold; PDF illustrates **5 minutes** as stale default.
- For each, call `fetchPaymentStatus` for **the correct gateway attempt/provider ID**, with rate limiting.
- Compare authoritative gateway observations with locally confirmed facts, using provider version/timestamps and capabilities to assess whether status is final.
- If local state is stale and gateway outcome is trustworthy, apply permitted state transition with `RECONCILIATION_OVERRIDE` audit event. Preserve old history.
- If discrepancy is high-risk (`CAPTURED` internally, provider says `FAILED`), create `reconciliation_anomalies` and alert; **do not silently force CAPTURED -> FAILED** or lose audit evidence.
- Generate an indexed `reconciliation_runs` record and per-payment `reconciliation_log` rows. API manual trigger should return run ID and allow retrieval of report.
- Ensure only one active reconciliation claim per payment at a time, with worker-safe leases/advisory locks.
- Test lost webhooks, delayed webhooks, unknown-outcome resolution, refund discrepancies, contradictory settled/captured states, repeated runs, gateway status API failure, concurrent schedule/manual trigger.

---

# 11. CIRCUIT BREAKER, RATE LIMITS, HEALTH METRICS — PART A §A3.3, §A8.4

### Circuit breaker

- Breakers are **per `(gateway,payment_method)`**.
- `CLOSED`: requests flow, count qualified infrastructure failures; example `5` consecutive failures -> `OPEN`.
- `OPEN`: skip this route and fail fast until `open_until` (default 30 seconds); no normal probes.
- `HALF_OPEN`: atomic single request/lease to probe; success -> `CLOSED` and reset; failure -> `OPEN` and cooldown again.
- Configuration held in DB and adjustable without redeployment.
- Don't count business declines or gateway rate limiting as generic infrastructure outages unless documented policy dictates otherwise.
- Metrics include qualified error rate, last response, consecutive failures and breaker transitions.

### Rate limiter and backpressure

- Outbound limiter per gateway; optionally per method/merchant/API endpoint if different provider limits apply.
- PDF **illustrative test fixtures**: Razorpay 200 req/sec; Stripe test 100 req/sec; PayU 150 req/sec; UPI aggregator-dependent. Actual provider limits must be configurable; do not hardwire fixture values as universal truths.
- Implement token bucket or sliding window with deterministic testable clock. Use bounded queuing/backpressure; honor provider `Retry-After` and jitter.
- Requests that exceed in-memory capacity must be delayed safely or rejected with clear retriable response; don't unboundedly accumulate work.
- Single-instance in-memory limiter can be acceptable for local demo but must document that cross-process coordination needs DB or Redis. A PostgreSQL-backed limiter provides shared safety if multiple processes make outbound calls.
- Health/metrics endpoint exposes utilization, for example `145/200 requests/sec`, alongside gateway state.

### Rolling analytics

- Persist observed latencies and outcomes; aggregate per-minute `gateway_health_metrics`, compute P95 over a clearly defined sliding window, and publish analytics.
- Measure success as reaching `CAPTURED` according to PDF routing definition, while separately tracking authorization and infra health.
- Keep metric counts accurate and avoid ambiguous denominators; annotate simulated data.

---

# 12. DISTRIBUTED TRACING AND AUDIT — PART A §A8.5 (PRINTED PAGE 23)

For each incoming payment request generate a UUID v4 `trace_id` (accept a validated trusted correlation ID if your policy permits). Propagate:

- API request context and successful/error responses.
- All DB state transition/audit entries and gateway route/attempt rows.
- Every application JSON log with `trace_id` **as a top-level field**.
- Outbound gateway API calls via provider-safe tracing metadata/header only if supported by provider; don't assume arbitrary headers are accepted.
- Webhooks: restore trace ID through provider reference -> `payment_attempts` -> `transactions`, rather than expecting providers to echo custom headers.
- Queue and reconciliation worker contexts.

Use Pino structured JSON keys such as `timestamp`, `level`, `trace_id`, `transaction_id`, `component`, `action`, `gateway`, `duration_ms`, `message`. Maintain immutable DB audit distinct from ordinary app logs. Add log redaction tests and correlated trace retrieval example in docs.

---

# 13. SECURITY, CORRECTNESS AND DATA SAFETY

**Do not accept, process, or store full raw cardholder data or UPI PIN.** Use provider-hosted/tokenized payment methods only; mock mode has fabricated test tokens.

- All secret keys via env/secret provider; no hardcoded keys, no leaked `.env` in Git.
- Authz on merchant endpoints, merchant scoping on reads and transaction mutations, admin authz on config/reconciliation/DLQ management.
- Webhook paths do **not** require merchant API keys; they require valid gateway cryptographic signatures, timestamps/replay controls and payload limits.
- Require HTTPS in non-local deployments; set security headers and request limits as appropriate.
- Use parameterized SQL, never concatenate user-supplied SQL fragments.
- Validate amounts, ids, allowed method/currency values, allowed capture/refund balances, metadata size and time window query ranges.
- Use constrained retries and outbound timeouts; never infinite loops or retry storms.
- Ensure no PII/credentials in log payload or audit gateway response (store sanitized metadata).
- For terminal/contradictory events create anomaly and require reconciliation rather than force nonsensical reverse transitions.
- Use transactional outbox or durable DB-first protocol for any side effect that cannot be retried safely; at minimum persist attempt/intention before HTTP request.
- Record clock skew and webhook source times; don't rely on arrival order alone.
- Avoid expired idempotency keys causing repeated merchant-order charges.
- Provide migration rollback safeguards and a README warning that destructive operations target only local/test databases.
- Do not claim PCI DSS/RBI compliance based solely on this demonstration.

---

# 14. TEST PLAN — MUST EXECUTE, NOT JUST DESCRIBE

Use unit, PostgreSQL integration, API contract, worker, and end-to-end mock gateway tests. Tests may control a clock for deterministic timeout and breaker behavior; do not use arbitrary sleeps for reliability.

## Mandatory scenarios

1. Happy-path card authorization then capture; audit contains each transition.
2. Instant/UPI-like mock payment successful without unsupported capture operation.
3. Partial capture, remaining authorization balance, valid additional capture or void.
4. Full refund after capture; no refund before capture.
5. Partial refund and cumulative refunds cannot exceed captured amount.
6. Hard issuer decline returns normalized error; no automatic unsafe reroute.
7. Definite Razorpay 5xx before processing -> alternate healthy gateway under test failover budget.
8. Gateway timeout after executing payment -> no second gateway charge; status eventually reconciled.
9. Concurrent same `Idempotency-Key` requests -> exactly one provider-side operation.
10. Same key with different payload -> rejection and no new charge.
11. Duplicate signed webhook events -> exactly one state effect/audit event.
12. Out-of-order webhook events -> no state regression; safe eventual status.
13. Invalid webhook signature / replay attempt -> rejected with no queue insertion.
14. Worker crash/retry and dead-letter queue after three retries; controlled replay succeeds.
15. Missing webhook -> scheduled reconciliation restores accurate state with override audit.
16. Internal CAPTURED vs gateway FAILED discrepancy -> anomaly, not silent overwrite.
17. Five qualifying failures trip correct per-method breaker; 30s cooldown; one half-open probe.
18. Gateway API rate limiting honors configurable limit and `Retry-After`, avoids accidental breaker trip.
19. Weighted routing matches seeded fixture and reconfiguration changes scores dynamically.
20. Concurrent capture/refund operations cannot exceed authorized/captured amounts.
21. Failover attempts preserve distinct provider references and same logical transaction.
22. PostgreSQL crash or queue write failure does not acknowledge an unsaved webhook.
23. Merchant isolation, admin auth, invalid input and sensitive log redaction.
24. Reconciliation concurrent invocations do not double-update state.
25. All 23 documented endpoints have positive and negative contract tests.

The PDF executive summary mentions evaluation against 15 scenarios but **does not enumerate all 15 in Part A**. This is an expanded test plan derived from Part A requirements, not a claim to reproduce the hidden evaluation list.

### Commands required

Provide functional scripts, adapted if necessary to repository conventions:

```sh
npm install
npm run db:migrate
npm run db:seed
npm run dev
npm run worker:webhooks
npm run worker:reconcile
npm run lint
npm run typecheck
npm run test
npm run test:integration
npm run test:e2e
npm run build
```

Use `docker compose up --build` for a reproducible run if Docker is installed. Provide test `.env.example`; `npm run test:integration` must run against a dedicated test PostgreSQL database, never a production DB. Include seed and teardown instructions. Tests must assert **database final state and provider call counts**, not just response codes.

---

# 15. REPOSITORY STRUCTURE

```text
payment-orchestrator/
├── src/
│   ├── app.ts
│   ├── server.ts
│   ├── api/
│   │   ├── routes/
│   │   ├── controllers/
│   │   └── middleware/
│   ├── modules/
│   │   ├── payments/
│   │   ├── state-machine/
│   │   ├── idempotency/
│   │   ├── routing/
│   │   ├── circuit-breaker/
│   │   ├── rate-limiter/
│   │   ├── webhooks/
│   │   ├── reconciliation/
│   │   ├── refunds/
│   │   └── analytics/
│   ├── gateways/
│   │   ├── gateway.interface.ts
│   │   ├── razorpay.adapter.ts
│   │   ├── stripe.adapter.ts
│   │   ├── payu.adapter.ts
│   │   ├── upi.adapter.ts
│   │   └── mocks/
│   ├── database/
│   │   ├── connection.ts
│   │   ├── migrations/
│   │   ├── seeds/
│   │   └── repositories/
│   ├── workers/
│   │   ├── webhook.worker.ts
│   │   ├── reconciliation.worker.ts
│   │   └── metrics.worker.ts
│   └── shared/
│       ├── config/
│       ├── errors/
│       ├── logging/
│       ├── types/
│       └── utils/
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── e2e/
│   ├── fixtures/
│   └── helpers/
├── docs/
│   ├── architecture.md
│   ├── state-machine.md
│   ├── routing-design.md
│   ├── data-model.md
│   ├── webhook-reliability.md
│   ├── failover-safety.md
│   ├── requirements-traceability.md
│   ├── test-results.md
│   ├── limitations.md
│   └── openapi.yaml
├── scripts/
├── .env.example
├── .gitignore
├── Dockerfile
├── docker-compose.yml
├── package.json
├── tsconfig.json
├── README.md
└── AGENTS.md
```

Add `/AGENTS.md` containing concise, enduring engineering conventions, safe operations, and test commands for future Codex sessions. The **master prompt file** itself should remain in docs or the repository root, not be replaced by AGENTS.md. Document any structure deviations.

---

# 16. IMPLEMENTATION ORDER AND WORKSTREAM GATES

Proceed in dependency order; do not ship an incomplete backend with a flashy UI.

### Gate 1 — Foundation

Scaffold TS/Express, typed config, Pino logger, Zod validation, normalized error middleware, PostgreSQL pool and Knex migrations, OpenAPI skeleton, Docker config. Verify boot, migrations, liveness and DB readiness.

### Gate 2 — Money and correctness

Implement schema, money minor units, transaction state machine/transition guards, append-only audit, `payment_attempts`, idempotency with concurrency tests. Verify no invalid transitions or double effects.

### Gate 3 — Intelligent orchestration

Implement four gateway interfaces/mocks, capabilities, router scoring, seed performance data, circuit breakers, outbound rate limiting, payment initiation/capture/void/refund service. Verify deterministic routing, safe reroute, hard decline and unknown outcomes.

### Gate 4 — Webhook durability

Implement cryptographic mock/real-sandbox signer as available, raw-body middleware, queue insertion, dedup, worker leasing, retries, DLQ, replay, state updates. Verify duplicate and crash behavior.

### Gate 5 — Reconciliation and metrics

Implement status polling, stale attempt reconciliation, anomaly rules, report APIs, success rate/latency/volume metrics, trace correlation.

### Gate 6 — Hardening and delivery

Complete all 23 routes and schema examples; run test suite and failure scenarios, inspect logs for secrets, run TypeScript build/lint, verify Docker Compose and README commands, generate traceability/limitations/test-results docs. Fix failing tests rather than weakening assertions.

For each gate, explicitly record files changed, functionality, tests executed and any blocked provider integration. Continue to the next gate when prerequisites pass.

---

# 17. SOURCE TRACEABILITY MATRIX

This table maps the coding work to printed Part A page numbers. Expand it into per-test `docs/requirements-traceability.md`.

| PDF Part A | Printed pages | Obligation | Implementation |
|---|---|---|---|
| A1 Payment Gateway Architecture | 3–4 | Payment chain, auth/capture, gateway differences, failure handling | adapters, payment services, capability matrix |
| A2 Transaction State Machine | 5–7 | ≥12 named states, guarded transitions, immutable state audit | FSM, state log, migration, tests |
| A3 Intelligent Routing | 8–10 | 5 weighted factors, composite score, half-open preference, seeded history, breakers | router, metrics, breaker, seeds |
| A4 Idempotency | 11–12 | Client key, 24h expiration, SHA-256 hash, PostgreSQL store, duplicates/concurrency | idempotency service, constraints, tests |
| A5 Webhooks & Reconciliation | 13–15 | signatures, dedup, queue, async processing, stale polling, anomaly alerts | webhook API, worker, reconcile |
| A6 Financial DB Design | 16–17 | 10 tables, indexes, monetary correctness | migrations, repositories |
| A7 RESTful API | 18–19 | 23 endpoints, OpenAPI 3.0, standard error | routes, Swagger, contract tests |
| A8 Concurrency / Locking | 20–21 | row locking, transactional advisory locking, release before gateway call, DLQ | repositories, locks, worker |
| A8 Rate Limiting | 22 | Token/leaky bucket, provider limits, utilization endpoint | outbound limiter, health APIs |
| A8 Distributed Tracing | 23 | UUID trace IDs, propagation, structured JSON logging | middleware, Pino, audit correlation |

---

# 18. AMBIGUITIES / NON-NEGOTIABLE ENGINEERING INTERPRETATIONS

The PDF is training material and contains useful requirements plus simplified illustrative snippets. Some must be translated into safe software contracts:

1. **'12 states' versus additional referenced states:** include the minimum 12 and extra states necessary for safe handling, with a formal state/event transition matrix. Note inconsistencies rather than silently copying invalid transitions.
2. **Two-second failover:** do not guarantee 2s for unresolved side-effecting network timeouts; enforce safety first and measure the supported scope.
3. **Webhook source of truth:** treat verified gateway observations as authoritative inputs, not as permission to overwrite contradictory internal financial evidence. Audit and quarantine anomalies.
4. **Webhook dedup + queue atomicity:** no HTTP 200 unless event committed durably. Processing may be asynchronous; use a second atomic transition when marking it complete.
5. **Idempotency expiry:** 24h key retention in training text does not license duplicate charges after 24h. Merchant order uniqueness and payment attempt ledger remain durable.
6. **API errors:** don't expose raw provider error objects or sensitive descriptions; normalize and redact.
7. **Provider details:** simplified fees/rates/features/signatures are seed/test assumptions, not verified contract facts. Verify actual SDK/docs for any real sandbox adapter.
8. **UPI gateway:** integrate through a legitimate PSP/aggregator where available; otherwise simulate faithfully and disclose mock-only status. Do not pretend direct NPCI access.
9. **Transaction vs operation states:** independently preserve payment attempt, refund, capture and settlement lifecycles; a single `state` column alone may not represent all concurrent realities.
10. **Configured min/max normalization:** with only one eligible gateway or equal values, guard against divide-by-zero and document fallback.
11. **'Production-grade' label:** code should be production-oriented and robust in a local/test environment; actual payment production requires security/compliance reviews, provider approvals, secret management, infrastructure and operational controls not provided by the PDF.
12. **3 webhook retries:** distinguish original processing attempt from retry count in docs and tests; ensure deterministic limit and DLQ promotion.

---

# 19. FINAL AGENT REPORT FORMAT

At end of implementation, produce a summary in chat and `docs/test-results.md`:

1. **Implemented:** modules and links/paths, all endpoint count, migrations, mocks, queue/reconciliation/health.
2. **Executed:** exact commands and pass/fail counts; include actual elapsed failover measurement and its scope. Never fabricate numbers.
3. **Verified invariants:** no duplicate payment operation for repeated key, transaction audit atomicity, no unsafe timeout rerouting, webhook replay safety, reconciliation anomaly preservation.
4. **Source mapping:** link to `docs/requirements-traceability.md`, note deviations and assumptions.
5. **Run instructions:** `docker compose up --build`, migrate/seed, start API/workers, Swagger URL, example curl/Postman scenarios and test commands.
6. **Limitations:** mock vs sandbox integrations, incomplete provider access, nonproduction infrastructure/security assumptions and any outstanding blocker.
7. **Known test gaps:** enumerate rather than masking; fix test failures wherever possible.

**Acceptance is based on reproducible, verified behavior, not a claim that the project is perfect.**

---
