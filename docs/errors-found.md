# Technical Errors Discovered in Training Materials & PDF

**Document Target:** `Zetheta_Backend_project.pdf`  
**Requirement Reference:** `[PDF-C, p.41]` (C6: Deliberate Technical Errors Bonus)  
**Evaluator Status:** 5 Confirmed Defensible Technical Inconsistencies / Errors  

---

### Finding 1: Webhook Replay with Modified Amount Contradicts HMAC Cryptography
- **Exact Citation:** Printed page 38, Case Study C4 (*Webhook Replay Fraud*), paragraph 2:  
  > *"The attacker intercepted a legitimate ₹10 payment webhook, modified the payload amount to ₹50,000, and replayed it to the webhook endpoint..."*
- **Technical Inconsistency:**  
  HMAC-SHA256 signatures are calculated across the exact raw bytes of the request body using a shared secret: $\text{HMAC}(K, \text{rawBody})$. Because cryptographic hash functions possess the avalanche effect and collision resistance, modifying even a single byte or digit (e.g. changing `1000` to `5000000`) produces a completely different digest. An attacker without access to the secret key cannot forge a valid signature for a modified body. The webhook receiver's signature verification will reject the modified body with `401 Unauthorized`.
- **True Exploitable Vulnerability:**  
  The real vulnerability is **semantic binding failure**, not cryptographic forgery: the attacker takes an **unmodified, validly signed ₹10 webhook** from a real low-value purchase and targets an unrelated ₹50,000 transaction ID. If the orchestrator checks only the HMAC signature and event ID without verifying that `payload.amount_minor === transaction.amount_minor`, it marks the ₹50,000 order as paid.
- **Impact on Repository:**  
  In `src/modules/webhooks/webhook.service.ts`, we implement deep semantic validation checking both `amount_minor` and `currency` against the locked database record, refusing to rely solely on signature verification.
- **Classification:** `CONFIRMED`.

---

### Finding 2: 30-Second Gateway Timeout vs < 2-Second Failover Contradiction
- **Exact Citation:** Printed pages 26 & 32 (Timeout specification) vs page 35 (C1 Failover SLA):  
  > *"Gateway simulator can simulate a 30-second socket timeout... The router must failover to an alternative gateway within 2 seconds."*
- **Technical Inconsistency:**  
  If the application waits for the upstream gateway's 30-second socket timeout, the request latency cannot be under 2 seconds. Conversely, if the orchestrator aborts the HTTP client connection after 2 seconds while the downstream gateway continues execution, the state of the payment at Gateway 1 is **ambiguous (`TIMEOUT_UNKNOWN`)**. If the orchestrator immediately initiates a failover charge to Gateway 2, Gateway 1 may subsequently capture the funds, resulting in a **double charge**.
- **Correct Architectural Behavior:**  
  Fast failover (<2s) is legally permitted **only** on verified non-holding errors (e.g., HTTP 503 Service Unavailable or HTTP 502 Bad Gateway), where the gateway definitively confirms funds were not held. On socket timeout or drop, the transaction must transition to `AUTH_TIMEOUT`, mark idempotency status `UNKNOWN`, and defer to out-of-band status polling and reconciliation without second charges.
- **Impact on Repository:**  
  Implemented in `PaymentApplicationService.initiatePayment`: failover is strictly restricted to `TRANSIENT_FAILURE`. `TIMEOUT_UNKNOWN` halts failover and returns HTTP 202 Accepted.
- **Classification:** `CONFIRMED`.

---

### Finding 3: Use of IEEE 754 Floating-Point Arithmetic for Monetary Values
- **Exact Citation:** Printed pages 5, 12, and 19 (Sample code and fee formulas):  
  > *"fee = amount * 0.02; total = amount - fee; ... amount: 49.99"*
- **Technical Inconsistency:**  
  Standard binary floating-point representation (IEEE 754 double precision) cannot accurately represent base-10 fractional decimals. Operations like `0.1 + 0.2` evaluate to `0.30000000000000004`. Over millions of transactions, fractional rounding errors accumulate, causing ledger imbalances, tax audit discrepancies, and rounding exploit vulnerabilities.
- **Correct Architectural Behavior:**  
  Monetary values must never be stored or manipulated as floats or decimals. All monetary values must be represented as **integer minor currency units** (e.g. cents, paise, pence: ₹50.00 is stored as `5000`) typed as `NUMERIC(16,0)` or `BIGINT` in the database and `bigint` / string in application code.
- **Impact on Repository:**  
  All entities use `amount_minor`, `authorized_minor`, `captured_minor`, and `refunded_minor` strictly as integer minor units with database constraint `chk_transactions_amount_positive`.
- **Classification:** `CONFIRMED`.

---

### Finding 4: Inconsistent Case Study Count Between Part C and Part D
- **Exact Citation:** Printed page 42, Part D introduction:  
  > *"You have reviewed all four case studies in Part C..."*
- **Technical Inconsistency:**  
  Part C explicitly enumerates and defines **five** distinct case studies:
  1. C1: Diwali Sale Double Charges (p. 34)
  2. C2: Silent Settlement Leak (p. 36)
  3. C3: UPI Mandate Exploitation (p. 37)
  4. C4: Webhook Replay Fraud (p. 38)
  5. C5: Flash-Sale Connection-Pool Stampede (p. 39)  
  Part D's claim of "all four" is an internal editorial inconsistency. Following it would lead an engineer to completely overlook C5.
- **Correct Architectural Behavior:**  
  Implement and test all five case studies (C1 through C5).
- **Impact on Repository:**  
  All 5 case studies are fully implemented with dedicated test suites in `tests/case-studies/`.
- **Classification:** `CONFIRMED`.

---

### Finding 5: Blanket Recommendation to "Subscribe to All Webhook Event Types"
- **Exact Citation:** Printed page 36, Case Study C2 (*Silent Settlement Leak*), paragraph 4:  
  > *"The reconciliation engine must subscribe to all gateway webhook event types to avoid missing settlement updates..."*
- **Technical Inconsistency:**  
  Modern payment providers (e.g. Stripe, Razorpay) emit dozens of webhook event types spanning subscriptions, invoices, customer tokens, payouts, disputes, identity verification, and terminal hardware telemetry. Subscribing indiscriminately to all events saturates the database queue (`webhook_queue`), causes connection pool starvation, and increases latency for critical payment authorization events.
- **Correct Architectural Behavior:**  
  The system should subscribe specifically to the curated set of payment and settlement lifecycle events (`payment.captured`, `payment.failed`, `payment.reversed`, `refund.processed`, `dispute.created`). The ingestion worker should process known events idempotently and safely acknowledge/discard unhandled non-financial events.
- **Impact on Repository:**  
  `WebhookService` defines explicit handlers for financial events while preventing queue bloat from extraneous webhooks.
- **Classification:** `CONFIRMED`.

