import pg from 'pg';
import { PaymentMethod, GatewayRouteRecord } from '../../shared/types/index.js';
import { GatewayConfigRepository } from '../../database/repositories/gateway-config.repository.js';
import { RoutingConfigRepository } from '../../database/repositories/routing-config.repository.js';
import { CircuitBreakerRepository } from '../../database/repositories/circuit-breaker.repository.js';
import { MetricsRepository } from '../../database/repositories/metrics.repository.js';
import { UnprocessableEntityError } from '../../shared/errors/index.js';

export interface GatewayCandidateScore {
  gateway: string;
  score: number;
  normalized_success: number;
  normalized_latency: number;
  normalized_cost: number;
  health_score: number;
  method_fit_score: number;
  raw_cost_minor: number;
  raw_p95_ms: number;
  raw_success_rate: number;
  breaker_state: string;
  selected: boolean;
  reason: Record<string, any>;
}

export interface RoutingResult {
  selectedGateway: string;
  routingConfigRevision: string;
  candidateScores: GatewayCandidateScore[];
}

export class IntelligentRouter {
  static async selectRoute(
    client: pg.PoolClient,
    params: {
      transactionId: string;
      paymentMethod: PaymentMethod;
      currency: string;
      amountMinor: string;
      traceId: string;
      excludeGateways?: string[];
    }
  ): Promise<RoutingResult> {
    const routingConfig = await RoutingConfigRepository.getConfig(client);
    const allGateways = await GatewayConfigRepository.getAll(client);
    const excluded = (params.excludeGateways || []).map((g) => g.toLowerCase());

    // 1. Filter eligible gateways
    const amount = BigInt(params.amountMinor);
    const eligible = [];

    for (const gw of allGateways) {
      if (!gw.enabled) continue;
      if (excluded.includes(gw.gateway_name.toLowerCase())) continue;
      if (!gw.supported_currencies.includes(params.currency)) continue;

      let methodSupported = false;
      if (params.paymentMethod === 'CARD' && gw.supports_card) methodSupported = true;
      if (params.paymentMethod === 'UPI' && gw.supports_upi) methodSupported = true;
      if (params.paymentMethod === 'NETBANKING' && gw.supports_netbanking) methodSupported = true;
      if (!methodSupported) continue;

      const breaker = await CircuitBreakerRepository.refreshState(client, gw.gateway_name, params.paymentMethod);
      const breakerState = breaker?.state || 'CLOSED';
      if (breakerState === 'OPEN') continue; // Exclude OPEN circuit breakers completely

      eligible.push({ config: gw, breakerState });
    }

    if (eligible.length === 0) {
      throw new UnprocessableEntityError(
        `No eligible gateway available for payment method ${params.paymentMethod} and currency ${params.currency}`,
        'NO_ELIGIBLE_GATEWAY'
      );
    }

    // 2. Compute raw metrics for each eligible gateway
    const rawData = [];
    const windowMinutes = routingConfig.metric_window_minutes || 15;

    for (const item of eligible) {
      const gw = item.config;
      const stats = await MetricsRepository.getRollingStats(
        client,
        gw.gateway_name,
        params.paymentMethod,
        windowMinutes
      );

      // Raw success rate (if 0 transactions, fallback to cold-start 98.0%)
      const successRate =
        stats.total_count > 0 ? stats.success_count / stats.total_count : 0.98;

      // Raw P95 latency (if 0 transactions, fallback to 350ms)
      const p95Latency = stats.p95_latency_ms > 0 ? stats.p95_latency_ms : 350;

      // Raw cost in minor units: (fee_bps / 10000) * amount + fee_fixed_minor
      const variableFee = Number((amount * BigInt(gw.fee_bps)) / 10000n);
      const totalCostMinor = variableFee + Number(gw.fee_fixed_minor);

      // Health score
      let healthScore = 1.0;
      if (item.breakerState === 'HALF_OPEN') {
        healthScore = 0.5;
      }

      rawData.push({
        gateway: gw.gateway_name,
        breakerState: item.breakerState,
        successRate,
        p95Latency,
        totalCostMinor,
        healthScore
      });
    }

    // 3. Normalization factors
    const minLatency = Math.min(...rawData.map((d) => d.p95Latency));
    const maxLatency = Math.max(...rawData.map((d) => d.p95Latency));
    const minCost = Math.min(...rawData.map((d) => d.totalCostMinor));
    const maxCost = Math.max(...rawData.map((d) => d.totalCostMinor));

    const wSuccess = Number(routingConfig.weight_success);
    const wLatency = Number(routingConfig.weight_latency);
    const wCost = Number(routingConfig.weight_cost);
    const wHealth = Number(routingConfig.weight_health);
    const wFit = Number(routingConfig.weight_method_fit);

    // 4. Calculate composite scores
    const candidates: GatewayCandidateScore[] = rawData.map((d) => {
      const normSuccess = d.successRate;
      const normLatency = maxLatency > minLatency ? (d.p95Latency - minLatency) / (maxLatency - minLatency) : 0.0;
      const normCost = maxCost > minCost ? (d.totalCostMinor - minCost) / (maxCost - minCost) : 0.0;
      const fitScore = 1.0;

      const compositeScore =
        wSuccess * normSuccess +
        wLatency * (1.0 - normLatency) +
        wCost * (1.0 - normCost) +
        wHealth * d.healthScore +
        wFit * fitScore;

      return {
        gateway: d.gateway,
        score: Math.min(1.0, Math.max(0.0, compositeScore)),
        normalized_success: Number(normSuccess.toFixed(4)),
        normalized_latency: Number(normLatency.toFixed(4)),
        normalized_cost: Number(normCost.toFixed(4)),
        health_score: d.healthScore,
        method_fit_score: fitScore,
        raw_cost_minor: d.totalCostMinor,
        raw_p95_ms: d.p95Latency,
        raw_success_rate: Number(d.successRate.toFixed(4)),
        breaker_state: d.breakerState,
        selected: false,
        reason: {
          weights: { wSuccess, wLatency, wCost, wHealth, wFit },
          raw: {
            successRate: d.successRate,
            p95Latency: d.p95Latency,
            totalCostMinor: d.totalCostMinor,
            breakerState: d.breakerState
          }
        }
      };
    });

    // Sort descending by score
    candidates.sort((a, b) => b.score - a.score || a.gateway.localeCompare(b.gateway));

    // 5. Half-open preference rule (PDF Section A3.2):
    // "If the selected gateway is in a degraded state (circuit breaker half-open),
    // the second-highest scoring gateway is preferred unless the score difference is greater than 20%."
    let selectedIndex = 0;
    if (candidates[0].breaker_state === 'HALF_OPEN' && candidates.length > 1) {
      const firstScore = candidates[0].score;
      const secondScore = candidates[1].score;
      const relativeDiff = firstScore > 0 ? (firstScore - secondScore) / firstScore : 0;
      const threshold = Number(routingConfig.degraded_preference_threshold || 0.20);

      if (relativeDiff <= threshold && candidates[1].breaker_state === 'CLOSED') {
        selectedIndex = 1;
        candidates[1].reason.selection_override = `Preferred healthier candidate over half-open candidate (diff ${Number((relativeDiff * 100).toFixed(2))}% <= 20%)`;
      }
    }

    candidates[selectedIndex].selected = true;
    const selectedGateway = candidates[selectedIndex].gateway;

    // 6. Record all evaluated routes in gateway_routes
    for (const c of candidates) {
      await client.query(
        `
        INSERT INTO gateway_routes (
          transaction_id, gateway, routing_config_revision, selected, score,
          normalized_success, normalized_latency, normalized_cost, health_score,
          method_fit_score, reason, trace_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      `,
        [
          params.transactionId,
          c.gateway,
          routingConfig.revision,
          c.selected,
          c.score.toFixed(8),
          c.normalized_success.toFixed(8),
          c.normalized_latency.toFixed(8),
          c.normalized_cost.toFixed(8),
          c.health_score.toFixed(8),
          c.method_fit_score.toFixed(8),
          JSON.stringify(c.reason),
          params.traceId
        ]
      );
    }

    return {
      selectedGateway,
      routingConfigRevision: routingConfig.revision,
      candidateScores: candidates
    };
  }
}
