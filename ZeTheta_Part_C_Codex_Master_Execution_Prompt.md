# ZeTheta Payment Orchestration — PART C: Codex Master Execution Prompt

**Purpose:** Autonomous, evidence-backed execution of **Part C: Case Studies & Real-World Applications**, printed PDF pages **34–40** (C1–C5), plus **C6 on page 41** for the optional error-detection bonus.

**Context:** Parts A and B are reported as completed. Work **inside the existing Part A + B repository**. This is an *audit → test → repair/extend → validate → document* exercise, **not** a rewrite or separate application.

**Authoritative source:** `Zetheta_Backend_project.pdf` (or `Zetheta_Backend_project(1).pdf`), printed pages cited below. If the PDF is unavailable in the workspace, proceed from the explicit requirements below and record that you could not independently cross-check it.

**Expected existing stack (verify; do not assume):** Node.js + TypeScript, PostgreSQL, Knex, REST APIs, mock gateways, state machine, gateway router, webhooks, reconciliation, test/load tooling, Docker Compose. Adapt to the actual codebase and avoid introducing unnecessary frameworks.

**Requirement labels:**
- `[PDF-C]`: Explicit requirement or design pattern in Part C (with printed page).
- `[PDF-B]`: Relevant Part B requirement or scenario, not a newly invented Part C mandate.
- `[ENGINEERING]`: Recommended implementation, test, documentation, or security safeguard; **not automatically a PDF requirement**.
- `[CONFLICT]`: Ambiguous, internally inconsistent, or potentially unsafe wording requiring careful engineering judgment and transparent documentation.

---

## 0. Operating contract — must follow

1. **Inspect before editing.** Inventory repository structure, git status, package scripts, database migrations, source modules, test suites, API contracts, mocks, deployment files, existing docs and existing Part B scenario outputs. Build a requirement-to-code mapping.
2. **Preserve completed work.** Do not reimplement working Part A/B features, regenerate the whole project, rename public endpoints, replace the existing database schema, or delete tests. Reuse and extend. Changes must be minimal and traceable.
3. **Never report unrun tests as passed.** Capture exact commands, exit codes, timings, logs, evidence locations and environment details. Distinguish: `PASS`, `FAIL`, `NOT_RUN`, `BLOCKED`, `PARTIAL`.
4. **Test real integration paths.** Mock only external gateway behaviour and controlled failures; use actual service/controller logic and PostgreSQL where meaningful. No placeholder test suites or `expect(true).toBe(true)` claims.
5. **No real-money transactions.** Use deterministic simulators/test credentials; no live payment operations or calls to production gateway endpoints. Keep secrets out of commits and logs.
6. **Keep financial correctness paramount.** No duplicate charge, premature fulfilment, illegal state transition, silent settlement mismatch, or false-success payment response. Preserve append-only audit evidence.
7. **Do not invent metrics.** If a measurement cannot be executed, mark it `NOT_RUN`/`BLOCKED`, state why, and provide the reproducible command.
8. **Read existing code and run commands autonomously** when tools permit. Do not stop to ask questions for minor choices; choose the smallest compatible design and document it. If credentials, runtime, or infrastructure are unavailable, continue with all feasible work and report blockers without misrepresenting completion.
9. **Respect the repository state.** Avoid `git reset --hard`, destructive database changes, force pushes, repo transfer, or production deployment. Do not push or submit remotely unless specifically authorized; provide local git commands if needed.
10. **Part C-wide explicit deliverable:** Students **must reference these case studies in architecture documentation** `[PDF-C, p.34]`. C6 bonus file `docs/errors-found.md` is specified `[PDF-C, p.41]`. Additional test files and reports below are `[ENGINEERING]` deliverables supporting reliable implementation.
11. Use the PDF's printed page numbering, not inferred chapter offsets. Preserve the difference between the document's narrative incidents and testable acceptance criteria.

## 1. First pass: discover and establish baseline

Perform, in order:

- Check git status and current branch; record existing uncommitted changes without overwriting them.
- Detect project tooling (`package.json`, test runner, eslint, tsconfig, Docker Compose, migrations, seeds), and locate source entry points.
- Enumerate tests for Part B scenarios **FS-01 through FS-15** and inspect test quality, not merely test names.
- Identify code paths for payment initiation, outbound retries, gateway idempotency, circuit breakers, mock gateway headers, transactional state changes, webhook signature/deduplication, settlement reconciliation, UPI expiry, fulfilment notifications, DB pooling, logging and health checks.
- Inspect whether `docs/architecture.md`, `docs/state-machine.md`, ADRs or existing `docs/errors-found.md` already exist; **augment rather than overwrite**.
- Run baseline lint, typecheck, unit tests, integration tests and (if feasible) a Dockerized/Postgres-backed smoke test. Note baseline failures separately from changes introduced for Part C.
- Create `docs/part-c-coverage-matrix.md`, using a table with columns `Case`, `PDF requirement`, `Existing implementation path`, `Existing test/evidence`, `Gap`, `Change planned`, `Final status`.

**Gate:** Do not start adding functionality until there is a concrete gap list, except minimal fixes necessary to get the baseline running.

## 2. C1 — Diwali sale double charges (printed pp.34–35)

### Source-grounded requirements

- `[PDF-C, p.35]` Attach a **client-generated UUID idempotency key** to each payment intent and preserve the same intent/key on retries.
- `[PDF-C, p.35]` Circuit breaker after **5 consecutive timeouts**, routing new eligible payments to Stripe/PayU; example says **within 500 ms**. Do not silently treat illustrative scenario values as universally achievable under a 30 s upstream timeout.
- `[PDF-C, p.35]` Retry backoff **1 s, 2 s, 4 s with jitter** rather than immediate retry bursts.
- `[PDF-C, p.35]` **Persistent asynchronous retry queue** so retries don't block checkout.
- `[PDF-B, pp.26–28]` Related: FS-01 primary timeout/failover under 2 seconds; FS-03 double-click same key returns 409 while processing; FS-09 concurrent multi-server duplicate returns 409; only one charge.

### Implementation/audit tasks

- Trace request-generated idempotency key to local DB uniqueness, merchant scope, outbound gateway request, retry worker, failover attempt and webhook reconciliation. Verify reused key cannot create a second charge for the **same merchant/payment intent**.
- Confirm distributed concurrency safety (unique constraint plus transaction/locking), not merely an in-memory Map or local mutex. Replay of completed requests must return deterministic prior result as appropriate.
- Verify actual circuit breaker threshold/configuration and behavior under timeout storms; ensure per-gateway/method semantics if the repository supports them.
- Ensure retry work is durable (DB-backed job/queue or already-installed reliable queue), bounded, observable, and idempotent. If present implementation already satisfies equivalent intent, reuse it.
- Ensure exponential backoff with jitter is configured consistently. Do not wait in a blocking HTTP request for 1+2+4 seconds.
- **Financial safety:** timeout/unknown outcome must not trigger a second independent charge; gateway status/reconciliation must resolve ambiguous outcomes. Do not blindly fail over a payment that may have already succeeded at the previous gateway.

### Automated scenarios (add only missing assertions)

1. Same idempotency key sent concurrently to two application workers: exactly one gateway payment intent/charge; second gets conflict while pending; no duplicate financial or audit records.
2. Retry queue re-delivers one job multiple times: no second charge, correct final state and deduplicated processing.
3. Five consecutive simulated timeouts: gateway circuit opens, subsequent *eligible/new* payments route elsewhere, breaker state recorded.
4. Slow/unknown gateway outcome: system reports pending/unknown or reconciles, **never falsely claims failure/success or charges twice**.
5. Backoff policy respects jitter/bounds using fake time/deterministic scheduler; avoid slow, flaky wall-clock sleeps.
6. Failed job restarts/process crashes: recovery from persistent queue without lost or duplicated effects.

**Acceptance:** Duplicate charges = 0 in executed scenarios; all attempts/state transitions auditable; circuit-breaker and retry evidence supplied.

## 3. C2 — Silent settlement leak (printed p.36)

### Source-grounded requirements

`[PDF-C, p.36]` Reconciliation engine must **subscribe to all relevant gateway webhook event types, not just captured/success**, reconcile periodically with gateway settlement APIs, **track settlement-batch inclusion for every captured transaction**, and **flag discrepancies immediately when detected**. The narrative highlights `payment.reversed`, `payment.failed`, and `dispute.created` as examples. `[PDF-B, p.28]` FS-11 expects anomaly records and alerts for 5 internally captured payments with reversed/failed settlement, with **NO automatic refund** pending human review.

### Implementation/audit tasks

- Audit webhook subscriptions/dispatcher and test handling of success, reversal, failure, disputes and settlement outcomes. **Do not claim all possible provider events are supported without verifying provider-specific APIs.** Use supported mock event mappings and clear unknown-event handling.
- Audit settlement record model. Store batch ID/reference, gateway, transaction reference, gross amount, fees, net amount, currency, settlement status, timestamp, and linkage as available. Introduce a compatible migration only if missing; never fabricate real settlement data.
- For captured transactions, represent **pending/not-yet-in-batch** distinctly from confirmed inclusion, instead of inventing a settlement batch at capture time. Flag overdue/unmatched transactions according to a configurable reconciliation window.
- Add or verify a periodic reconciliation runner that compares internal captured/settled data to gateway-provided settlement reports; follow existing scheduling infrastructure.
- Persist discrepancy/anomaly records and emit a distinguishable alert/event; do not silently overwrite capture history or automatically refund mismatch cases.
- Handle reversals/disputes via explicit supported state(s) or linked settlement/dispute records. No illegal `CAPTURED → FAILED` shortcut; add legal transition(s) and audit logs if needed.
- Preserve immutable state transition/audit history.

### Automated scenarios

1. Five captured payments absent or reversed in gateway settlement report => five anomaly records, distinct alert evidence, **zero auto-refunds**, reproducible reconciliation report.
2. Captured transaction included in settlement batch => correct batch ID, amount/currency linkage, no false discrepancy.
3. Reversal/dispute callback after capture => safely processed; matching lifecycle/audit/dispute state; no unhandled event.
4. Duplicate and out-of-order settlement events => idempotent, consistent results.
5. A captured payment not yet due for settlement => tracked as pending, not incorrectly marked as financial loss.

**Acceptance:** Reconciliation detects seeded mismatches, maintains batch membership data, alerts, and never issues unauthorized refunds.

## 4. C3 — UPI mandate exploitation (printed p.37)

### Source-grounded requirements

- `[PDF-C, p.37]` **Fulfilment begins only AFTER `CAPTURED`**, not at UPI collect initiation/`AUTH_INITIATED`.
- `[PDF-C, p.37]` UPI collect requests track the **5-minute** expiry and transition to `AUTH_EXPIRED` after the window.
- `[PDF-C, p.37]` Order/fulfilment notifications are driven by captured payment state changes.
- `[PDF-B, p.28]` FS-12: poll gateway on expiry, receive `EXPIRED`, transition to `AUTH_EXPIRED`, notify customer, and **do not force-retry** an expired UPI collect.

### Implementation/audit tasks

- Locate the payment-to-order/fulfilment integration or its simulated event interface. If no real order domain exists, add the **minimum mock consumer/contract** to prove the gating behaviour; do not construct a full e-commerce app.
- On UPI collect, persist authoritative expiry/deadline; use a clock-injected scheduler or expiration worker for deterministic tests, with gateway status check before finalizing expired state.
- Only emit `payment.captured`/`fulfilment.allowed` after authoritative confirmation and a committed legal state transition. Ensure duplicate webhook/API responses cannot trigger duplicate fulfilment.
- Race-proof near-expiry approval/decline webhooks and polling. Reconcile unknown outcome rather than asserting expired in contradiction to gateway-confirmed capture.
- Provide pending/expired customer status response or event consistent with existing API design.

### Automated scenarios

1. Initiate collect => no fulfilment while pending.
2. Advance fake time to 4m59s => still pending/no fulfilment (unless confirmed captured).
3. After 5 minutes with gateway-confirmed expiry => `AUTH_EXPIRED`, notify, zero fulfilment events, zero retries.
4. Captured success before expiry => exactly one fulfilment event even on duplicate callbacks.
5. Approval/decline/expiry racing at boundary => legal final state and no unauthorized fulfilment.

**Acceptance:** Zero fulfilment on pending/expired collections; exactly once logically on confirmed captured, with reproducible clock-driven tests.

## 5. C4 — Webhook replay fraud (printed p.38)

### Source-grounded requirements

`[PDF-C, p.38]` After signature verification, enforce **amount match**, **gateway order/payment transaction ID match**, **currency match**, **valid state transition**, and **replay detection** using `processed_webhook_events`. `[PDF-B, pp.26,28]` FS-02 duplicate webhook returns HTTP 200 without double-processing; FS-10 tampered amount invalidates HMAC signature and is rejected with 401 and security audit event.

### Implementation/audit tasks

- Verify signatures on raw request body before trusting parsed fields; use provider-specific schemes and constant-time comparison as appropriate. Use no production secrets in tests.
- Bind incoming event to the correct *merchant and payment intent* using trusted, persisted gateway references; never trust only an order ID supplied by webhook payload. Verify expected amount in **minor currency units**, no float-based rounding, and currency equality.
- Validate provider event type/status against allowed state-machine transitions. Distinguish already-applied duplicate from malicious invalid transition.
- Atomically deduplicate `(gateway, event_id)` and commit corresponding financial state change, preventing concurrent handler races. Duplicate legitimate deliveries should acknowledge without replaying effects.
- Reject unrecognized/incorrect references and mismatching amounts/currencies, recording redacted security evidence. Preserve event provenance and do not leak sensitive payloads.

### Automated scenarios

1. Bit-flipped payload with old signature => authentication failure (FS-10).
2. **Validly signed** ₹10 event deliberately associated with unrelated ₹50,000 order => mismatch rejection and **no** paid state (critical C4 test).
3. Valid signature but wrong gateway reference/payment ID => rejection.
4. Valid signature but wrong currency => rejection.
5. Valid signature but invalid state transition => rejection without state corruption.
6. Legitimate duplicate event three times and concurrently => one effect, repeat deliveries acknowledged (FS-02).
7. Replay that uses a new event ID but a previously used gateway transaction reference => no second financial effect.

**Acceptance:** No forged or mismatched webhook can mark an order paid; correctly signed and matched new events still work; replay and concurrency safety proven.

**[CONFLICT, p.38]** The narrative refers to replaying a signed ₹10 webhook with a modified amount, yet modifying an HMAC-protected payload would invalidate the original signature. Interpret the deeper C4 exploit correctly: a **validly signed low-value event erroneously linked to a high-value order**, not a cryptographic signature forgery. Cover **both** the tampered-signature scenario and the valid-signature/wrong-order scenario as separate tests. Document this distinction; never bypass signature verification.

## 6. C5 — Flash-sale connection-pool stampede (printed pp.39–40)

### Source-grounded requirements

`[PDF-C, p.40]` **Do not hold DB connections while waiting for gateway API calls**; use acquire/read/release → gateway call → acquire/write/release. The case study identifies **PgBouncer transaction pooling** as an option, **non-DB error logging**, and **internal circuit breaker/fail-fast HTTP 503** on DB saturation. `[PDF-B, p.29]` FS-14 further describes PgBouncer **or equivalent**, separation of long-running reconciliation queries (read replica mentioned), asynchronous webhook queue, and internal resource circuit breaker.

### Implementation/audit tasks

- Trace Knex transactions and connection lifetime in payment initiation, capture, refund, failover, webhook and reconciliation paths. Refactor external I/O **outside** DB transactions and row-level locks.
- Enforce short atomic DB critical sections with state validation and audit insert. Use intermediate states, version checks, advisory locks, or unique constraints to preserve concurrency correctness across release/reacquire.
- Set bounded pool sizes, acquisition timeout and controlled queue/backpressure. Inspect connection telemetry (active, idle, waiting, acquisition timeout) and provide metrics/health endpoints if feasible.
- On DB unavailability/exhaustion, respond with 503 and bounded `Retry-After` where appropriate, never recurse into a DB-backed error logger. Use structured stderr/file/in-memory fallback and redaction.
- Evaluate PgBouncer only if compatible with existing stack/deployment; if configured, document transaction-pooling caveats and test actual deployment. If not viable, use and explain an equivalent local strategy without claiming PgBouncer installed.
- Inspect separation/limits of reconciliation versus hot-path queries. Avoid promising a read replica unless actually provisioned and tested; provide documented limitation and reasonable job isolation otherwise.
- Preserve webhook ingestion durability under DB outage: never acknowledge accepted-before-persisted events as durably queued. Define retryable HTTP behaviour.

### Automated scenarios

1. Simulate slow 2–5 s gateway response while connection pool is small; prove DB connections are **not** held throughout external call (instrument query/transaction boundaries).
2. Saturate pool (e.g., max 20 in isolated test) and assert bounded 503/fail-fast behaviour; no deadlock or recursive DB logging.
3. DB returns after outage => service recovers and previously durable work can be processed safely.
4. Concurrent payment/test traffic => pool metrics accurate, transactions consistent, no duplicate effects.
5. Reconciliation workload does not starve checkout in feasible controlled test; if architecture lacks replicas, document limits.

**Acceptance:** Bounded failure, visible pool saturation, no recursive error amplification, no connections held across gateway calls, recovery evidence.

## 7. C6 — Optional bonus: identify deliberate technical errors (printed p.41)

`[PDF-C, p.41]` The document says there are **5 deliberate technical errors** in its training material/case studies. **At least 3 correctly identified/explained in `docs/errors-found.md`** yields **25 bonus points**; **all 5** yields **50 bonus points**.

Perform a focused technical review of the **whole supplied PDF** for protocol claims, mathematical formulas, gateway capabilities and database recommendations. For **each defensible finding** record:

- Exact PDF printed page and original claim (brief quotation or faithful paraphrase).
- What's technically wrong or misleading; assumptions/version if relevant.
- Correct behavior/approach, and impact on this repository.
- **Evidence:** primary protocol/provider/official PostgreSQL documentation or a reproducible computation/test. Links may be included if accessible; otherwise mark `PENDING_EXTERNAL_VERIFICATION` and don't claim confirmation.
- Classification: `CONFIRMED`, `LIKELY`, or `NEEDS_VERIFICATION` with reasoning.

**Do not hallucinate 5 errors or assert qualification for bonus points unless five defensible findings have evidence.** Keep speculative items in a separate candidate section, clearly labeled. If the PDF is inaccessible, report the limitation. Correct project code for any confirmed unsafe guidance while preserving clear distinction between PDF expectations and safer engineering behavior.

## 8. Cross-cutting verification — retain Parts A & B

### Part B scenario crosswalk

| C section | Relevant existing Part B scenarios | Additional Part C-specific risk |
|---|---|---|
| C1 | FS-01, FS-03, FS-09 | Durable async retries, jitter, ambiguous timeout outcome |
| C2 | FS-11 | Post-capture reversals, settlement batch membership, event coverage |
| C3 | FS-12 | Explicit fulfilment gate and near-expiry race |
| C4 | FS-02, FS-10 | **Valid** signed payment for **wrong** order / amount / currency |
| C5 | FS-14 | DB held during gateway calls, recursive error logging, resource fail-fast |

### Required verification sequence

1. Run focused C1–C5 tests and save full results.
2. Rerun all available existing FS-01..FS-15 tests. Report all 15 individually; absent tests must be `NOT_RUN` or `MISSING`, never assumed `PASS`.
3. Rerun existing unit/integration suites; lint and typecheck; verify migrations up and (where safe) migration rollback in isolated test database.
4. Start real Docker Compose dependencies in an **isolated environment**, verify migrations and health endpoint. The PDF's `[PDF-B, p.31]` harness expects a start/health response within **60 seconds**.
5. Run load tests with existing k6/Artillery scripts if installed/feasible; do not quietly install or require a huge new stack. Capture throughput, p50/p95, errors, database utilization, failover behavior and scenario outcome.
6. Refer to existing `[PDF-B, p.30]` benchmark targets accurately: payment initiation P95 <500 ms; failover <2 s; webhook processing P95 <200 ms; sustained 100 req/s for 5 minutes; idempotency check <10 ms; reconciliation of 10,000 transactions <30 s. **Only claim a target was achieved if actually measured in an appropriately comparable environment.**
7. Run financial data-integrity assertions: no orphan financial rows, no duplicate charges per payment intent, consistent minor-unit amounts and currencies, legal state transitions, append-only audit logs, no silent anomalies or unauthorized refunds.
8. Include fault tests and all infrastructure assumptions in evidence reports, including inability to reproduce full production-scale user numbers in local VM.

### Important cross-section conflicts to resolve transparently

- `[CONFLICT, PDF-B pp.26,32 vs PDF-C pp.34–35]` Mock gateway can simulate 30 s timeout but failover target is <2 s. Define fast detection/cancellation and *ambiguous outcome reconciliation*, not an unbounded request and not automatic double charge. Document measured scope (detection-to-response vs total payment wall time).
- `[CONFLICT, PDF-C p.38]` Valid webhook signature is **not** authorization for a different order; never conflate signed low-value event with tampered signed bytes.
- `[CONFLICT, PDF-D p.42]` Part D refers to “all four case studies” even though Part C enumerates **C1 through C5 (five)**. Cover all five.
- `[CONFLICT, PDF-C p.36]` “Subscribe to ALL webhook event types” should be implemented as **all relevant supported payment/settlement/dispute events**, with explicit handling or safe rejection of unknown events; not an unsupported blanket assertion about every provider event.
- `[ENGINEERING]` The example values in Part C incident narratives are background, not load-test obligations requiring millions of real requests.

## 9. Documentation to write/update

1. **`docs/architecture.md` (explicit PDF requirement):** Integrate dedicated subsection “Part C — Real-World Failure Prevention” covering **C1–C5**. For each: incident summary; root cause; applicable design patterns; exact repository modules/files; message/data flow; consistency guarantees; associated Part B FS IDs; actual tests and results; limitations. Include Mermaid sequence/flow diagrams where they add clarity, especially payment timeout/unknown outcome and webhook fulfilment gate. Retain existing architecture content.
2. **`docs/part-c-coverage-matrix.md`** `[ENGINEERING]`: The discovered mapping, missing coverage, fixes, and evidence, updated to final status.
3. **`docs/part-c-test-report.md`** `[ENGINEERING]`: A test-evidence matrix: test ID, scenario, expected result, actual result, PASS/FAIL/NOT_RUN/BLOCKED, command, environment and artifact/log path. Include existing 15 Part B scenarios and measured targets only when run.
4. **`docs/part-c-change-log.md`** `[ENGINEERING]`: File-level edits and reasons; schema migrations; compatibility changes; security implications; known limitations. Separate baseline defects from Part C changes.
5. **`docs/errors-found.md`** `[PDF-C, p.41]`: Defensible verified errors and corrections; track uncertainties honestly. Preserve an existing file's verified findings if present.
6. **`README.md`** `[ENGINEERING]`: Minimal commands to start DB/app, seed deterministic mocks, run focused Part C tests, full regression tests, migrations, load tests and read reports. Never claim optional services are required when not used.
7. **`tests/case-studies/`** `[ENGINEERING]`: C1–C5 tests or repository-conventional equivalent; good naming, reusable fixtures, deterministic time, mock response injection. Tests must assert database/audit effects, not just HTTP status.

## 10. Quality gates and definition of done

**Gate A: Coverage:** Every C1–C5 requirement mapped to an implementation path and a meaningful test or documented gap; Part C architecture references complete.

**Gate B: Correctness:** All tests runnable in the environment pass; any failures/blocks explicitly enumerated. Never suppress failing tests or weaken assertions to show green.

**Gate C: Financial safety:** No duplicate charge, false captured state, premature fulfilment, unauthorized refund, or silent settlement mismatch in tested scenarios; all changes preserve immutable audit trails.

**Gate D: Compatibility:** Existing public contracts, Part A/B functionality, migrations and mock controls remain compatible. Any deliberate breaking change documented with rationale.

**Gate E: Evidence:** Real logs, results and commands recorded; measured targets distinguish actual vs target vs unavailable.

**Gate F: Bonus:** `docs/errors-found.md` includes only defensible findings and verification status; bonus points never represented as guaranteed.

## 11. Execution order and final response from coding agent

Work through **these six stages without stopping prematurely**:

1. **DISCOVER:** repository inventory, baseline checks, matrix.
2. **DESIGN:** minimal remediation plan, schema/API/worker changes if necessary; resolve ambiguous payment outcomes safely.
3. **IMPLEMENT:** only missing C1–C5 protections and supporting migrations/mocks; tests alongside changes.
4. **VERIFY:** focused cases, Part B full regression, Docker+Postgres, financial integrity, feasible benchmarks; fix regressions and rerun.
5. **DOCUMENT:** architecture Part C references, matrix, report, changes, README, C6 bonus file.
6. **REPORT:** concise actual results and precisely what remains blocked.

At the end print this exact *information* (with truthful values, not a fabricated template completion):

- Repository branch and initial git status.
- Modules/paths reused from existing Parts A/B.
- C1, C2, C3, C4, C5 final statuses, each with evidence path.
- Files created/modified and any migrations.
- Test counts (passed/failed/skipped) with exact commands; status for FS-01..FS-15.
- Actual measured benchmark values (or `NOT_RUN` and reason).
- `docs/errors-found.md`: count of **verified** findings vs tentative items.
- Remaining limitations and any security/financial correctness concerns.
- **Do not claim the submission was transferred, pushed, certified or accepted.** Those actions require separate evidence/authorization.

**Start now by inspecting the existing repository. Do not replace it with a new project.**
