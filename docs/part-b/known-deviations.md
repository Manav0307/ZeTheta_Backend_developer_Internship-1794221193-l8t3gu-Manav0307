# Part B Architectural Decisions & Safety Deviations

This document documents engineering safety decisions regarding FS-01, FS-07, FS-11, and FS-14 to distinguish strict financial invariants from naive benchmark simulations.

---

## 1. FS-01: Gateway Timeout Double-Charge Risk (Invariant #2)

- **Issue:** Naive simulation scenarios often suggest that when a primary gateway times out during authorization, the system should instantly failover to a second gateway.
- **Safety Concern:** Downstream socket timeouts (`TIMEOUT_UNKNOWN`) mean the orchestrator did not receive an acknowledgment, but the gateway may have successfully debited the customer's account or held authorization. Failing over blindly to a second gateway would cause a double-debit (double hold) on the customer's card.
- **Engineering Decision:**
  - On verified `TRANSIENT_FAILURE` (HTTP 503 / 500) where the gateway confirms funds were not held, failover to an alternate gateway is strictly permitted.
  - On unconfirmed `TIMEOUT_UNKNOWN` (socket drop / network drop), failover is **strictly prohibited**. The transaction transitions to `AUTH_TIMEOUT`, the idempotency key is marked `UNKNOWN`, and active background reconciliation is scheduled to verify the downstream status before taking further action.

---

## 2. FS-07: Payment Method-Fit Routing Invariant

- **Issue:** Cascade failure scenarios suggest rerouting all traffic away from a failing gateway to any remaining active gateway.
- **Safety Concern:** Payment instruments are not interchangeable. Stripe supports CARD instruments, but does not support domestic Indian UPI collect mandates or Netbanking. Attempting to failover a UPI transaction to Stripe will result in guaranteed decline or malformed payload exceptions.
- **Engineering Decision:**
  - The router enforces strict `capabilities.supports*` filtering prior to score evaluation.
  - If Razorpay trips for UPI, traffic fails over only to other UPI-capable gateways (`payu`, `upi`). Card-only gateways (`stripe`) are strictly excluded regardless of health score.

---

## 3. FS-11: Reconciliation Anomaly & Auto-Refund Safety

- **Issue:** In FS-11, captured transactions are missing from a gateway settlement report file. Naive workflows might auto-refund the transaction or mark it failed internally.
- **Safety Concern:** A settlement report can be delayed, batched across different cutoffs, or manually held by the gateway for compliance review. Auto-refunding a transaction that was already captured results in merchant financial loss (customer keeps goods and gets refund).
- **Engineering Decision:**
  - The reconciliation engine flags missing settlement rows as `RECONCILIATION_MISMATCH` with severity `HIGH`.
  - An append-only audit record `SETTLEMENT_INVESTIGATION_LOGGED` is recorded.
  - The financial ledger is **not mutated**: the transaction remains `CAPTURED`, no auto-refund is triggered, and alerting is dispatched for human ops review.

---

## 4. FS-14: Database Pool Saturation & Backpressure

- **Issue:** Flash-sale traffic spikes can saturate the PostgreSQL connection pool.
- **Safety Concern:** Without bounded backpressure, requests queue indefinitely, exhausting Node.js memory or triggering unhandled client disconnects.
- **Engineering Decision:**
  - Database pools are configured with explicit connection timeouts.
  - Incoming requests under pool saturation fail fast with HTTP 503 `SERVICE_UNAVAILABLE` or HTTP 429.
  - Webhooks arriving during pool congestion return HTTP 503 so upstream gateways back off and retry, preventing silent webhook loss.

