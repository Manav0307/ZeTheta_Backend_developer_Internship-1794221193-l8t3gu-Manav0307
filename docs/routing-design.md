# Intelligent Routing Engine Design

## 1. Overview & Objective

The Intelligent Dynamic Routing Engine evaluates available payment gateway adapters in real time to select the optimal processing route for each transaction. The selection maximizes transaction success rates and system health while minimizing merchant operational fees and processing latencies.

All candidate evaluations and scoring breakdowns are persisted to the `gateway_routes` audit table for forensic auditability and route performance analytics.

---

## 2. The 5 Weighted Evaluation Factors

The engine applies a multi-factor linear utility function configured with the weights prescribed on page 10 of `Zetheta_Backend_project.pdf`:

$$\text{Total Score} = w_{\text{SR}} \cdot S_{\text{SR}} + w_{\text{Fee}} \cdot S_{\text{Fee}} + w_{\text{Lat}} \cdot S_{\text{Lat}} + w_{\text{Health}} \cdot S_{\text{Health}} + w_{\text{Prio}} \cdot S_{\text{Prio}}$$

| Factor | Description | Default Weight ($w_i$) | Utility Objective |
|---|---|---|---|
| **Success Rate ($S_{\text{SR}}$)** | 24-hour rolling completed auths over total attempts | **0.35** (35%) | Maximizes conversion ($0.0 \to 1.0$) |
| **Processing Fee ($S_{\text{Fee}}$)** | Normalized processing cost per transaction | **0.20** (20%) | Minimizes merchant processing fees |
| **Latency ($S_{\text{Lat}}$)** | Normalized average round-trip duration in ms | **0.20** (20%) | Minimizes end-user waiting time |
| **Gateway Health ($S_{\text{Health}}$)**| Circuit breaker state and availability index | **0.15** (15%) | Protects against degraded downstream APIs |
| **Commercial Priority ($S_{\text{Prio}}$)**| Contractual volume commitments and priority | **0.10** (10%) | Honors merchant commercial agreements |

The sum of all weights strictly equals $1.00$ ($0.35 + 0.20 + 0.20 + 0.15 + 0.10 = 1.00$).

---

## 3. Factor Normalization Curves

Because fee, latency, and success rates operate across fundamentally different dimensional units, each factor is normalized to a dimensionless value between $0.00$ and $1.00$:

### 3.1 Success Rate ($S_{\text{SR}}$)
$$\text{SR} = \frac{\text{Successful Attempts}}{\text{Total Attempts}}, \quad S_{\text{SR}} = \min(1.0, \max(0.0, \text{SR}))$$

### 3.2 Processing Fee Normalization ($S_{\text{Fee}}$)
Lower fees yield higher utility scores:
$$S_{\text{Fee}} = 1.0 - \frac{\text{fee} - \min(\text{fees})}{\max(\text{fees}) - \min(\text{fees})}$$
*(If all candidate fees are identical, $S_{\text{Fee}} = 1.0$.)*

### 3.3 Latency Normalization ($S_{\text{Lat}}$)
Lower latency yields higher utility scores:
$$S_{\text{Lat}} = 1.0 - \frac{\text{latency} - \min(\text{latencies})}{\max(\text{latencies}) - \min(\text{latencies})}$$
*(If all candidate latencies are identical, $S_{\text{Lat}} = 1.0$.)*

### 3.4 Gateway Health Index ($S_{\text{Health}}$)
Derived from the active Circuit Breaker state:
- **`CLOSED`**: $S_{\text{Health}} = 1.0$ (Fully healthy)
- **`HALF_OPEN`**: $S_{\text{Health}} = 0.5$ (Probing state)
- **`OPEN`**: Candidate excluded from routing evaluation entirely ($S_{\text{Health}} = 0.0$)

### 3.5 Commercial Priority ($S_{\text{Prio}}$)
$$\text{Priority} \in [1, 10], \quad S_{\text{Prio}} = \frac{\text{Priority}}{10.0}$$

---

## 4. Historical Performance Fixtures (PDF p. 10)

The system seeds the historical performance table from the assignment specification into `gateway_health_metrics`:

| Gateway | Payment Method | Success Rate | Fee Structure | Avg Latency | Health Index | Commercial Priority |
|---|---|---|---|---|---|---|
| **Razorpay** | CARD / NETBANKING / UPI | 92.5% | 2.0% + ₹0 | 850 ms | 0.98 | 9 |
| **Stripe** | CARD | 94.0% | 2.9% + ₹3 | 650 ms | 0.99 | 8 |
| **PayU** | CARD / NETBANKING | 89.0% | 1.8% + ₹0 | 1100 ms | 0.94 | 7 |
| **UPI (Direct)**| UPI | 96.0% | 0.0% + ₹0 | 350 ms | 0.99 | 10 |

---

## 5. Circuit Breaker Half-Open 20% Preference Rule

When a gateway recovers from an `OPEN` state into `HALF_OPEN`:
1. It is eligible to accept probe traffic.
2. However, to safeguard against overwhelming a recovering upstream partner, **if an alternate healthy candidate (`CLOSED`) exists whose composite score is within 20% of the half-open gateway, the healthy candidate is preferred**.
3. The recovering gateway only receives traffic if it holds a decisive score advantage ($> 20\%$) or no other healthy candidate supports the requested payment method.

---

## 6. Safe Failover Exclusion Mechanism

When a payment attempt encounters a transient gateway failure (e.g., HTTP 503 or network drop):
- The router is invoked with `excludeGateways: [failedGateway]`.
- This guarantees that the rerouted attempt does not bounce back to the gateway that just failed on this payment, even if that gateway's breaker has not yet tripped (which requires 5 consecutive failures).
- The secondary candidate is dispatched in $< 2$ seconds without user friction.

