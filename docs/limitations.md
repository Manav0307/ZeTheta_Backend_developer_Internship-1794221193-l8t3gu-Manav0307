# Operational Limitations & Non-Production Disclosures

## 1. Scope & Compliance Disclosures

In strict compliance with the assignment instructions and project scope constraints:

1. **Strictly Limited to Part A:**
   This implementation strictly addresses **Part A: Training Material & Learning Resources (printed pages 3–23)** of `Zetheta_Backend_project.pdf`. Requirements, interfaces, and specifications from Parts B, C, D, E, and F are intentionally not implemented.

2. **No Production Payment Gateway Readiness Claim:**
   The gateway adapters included in this codebase (`RazorpayAdapter`, `StripeAdapter`, `PayUAdapter`, `UPIAdapter`) operate in an automated mock and sandbox simulation mode. **This software does not claim live production readiness with real financial clearing houses, bank networks, or live payment gateways.**

3. **No Real Financial Credentials or Live Funds:**
   All cryptographic keys, API credentials, webhooks, and transactions operate on synthetic test data. No real credit card numbers, live bank accounts, or financial funds were processed, debited, or transferred during the implementation or verification of this project.

---

## 2. Industry Standards & Regulatory Non-Production Boundaries

While the architecture exemplifies enterprise design patterns, the following production regulatory and compliance controls were outside the defined scope of Part A:

| Area | Production Requirement | Part A Implementation Scope |
|---|---|---|
| **PCI-DSS Level 1** | Cardholder Data Environment (CDE) segmentation, PCI PIN security, network HSM encryption. | Mock adapters avoid handling raw Primary Account Numbers (PAN); synthetic tokens and card references only. |
| **RBI Card-on-File Tokenization (CoFT)** | Mandated tokenization with authorized card networks (Visa/Mastercard/RuPay) via TSP. | Simulated token generation; no direct network TSP connection. |
| **UPI Intent / PSP Clearing** | Direct NPCI UPI PSP integration and NPCI Common Library (CL) hardware signature verification. | Deterministic mock adapter verifying UPI virtual payment addresses and SHA-256 signatures. |
| **Two-Factor Authentication (3D Secure / OTP)**| Mandatory 3DS 2.0 / EMVCo challenge redirection and SMS OTP interception. | Synchronous mock authorization simulating issuer approval/decline responses. |

---

## 3. Local Environment & Infrastructure Assumptions

1. **PostgreSQL Version:** Developed and verified against native PostgreSQL 18.6 (`pg_advisory_xact_lock`, partial unique indexes, composite foreign keys, PL/pgSQL triggers).
2. **Worker Concurrency:** Asynchronous workers (`WebhookWorker`, `ReconciliationWorker`) operate within Node.js process timers for development and test execution. In high-throughput production clusters, these workers should be hosted in dedicated worker pods with Kubernetes Horizontal Pod Autoscalers (HPA).
3. **In-Memory Rate Limiter:** The current `OutboundRateLimiter` maintains token bucket state in-memory within the active Node process. In multi-instance distributed deployments, rate limiting state should be backed by a centralized Redis cluster using Lua scripts for distributed token consumption.

