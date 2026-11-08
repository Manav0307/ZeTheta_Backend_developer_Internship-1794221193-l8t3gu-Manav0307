import type { Knex } from 'knex';

export async function seed(knex: Knex): Promise<void> {
  // 1. Initial routing config
  await knex.raw(`
    INSERT INTO routing_config (
      id, revision, weight_success, weight_latency, weight_cost, weight_health, weight_method_fit,
      metric_window_minutes, degraded_preference_threshold
    ) VALUES (
      1, 1, 0.35000, 0.20000, 0.20000, 0.15000, 0.10000, 15, 0.20000
    )
    ON CONFLICT (id) DO UPDATE SET
      weight_success = EXCLUDED.weight_success,
      weight_latency = EXCLUDED.weight_latency,
      weight_cost = EXCLUDED.weight_cost,
      weight_health = EXCLUDED.weight_health,
      weight_method_fit = EXCLUDED.weight_method_fit,
      metric_window_minutes = EXCLUDED.metric_window_minutes,
      degraded_preference_threshold = EXCLUDED.degraded_preference_threshold;
  `);

  // 2. Gateway configurations
  await knex.raw(`
    INSERT INTO gateway_config (
      gateway_name, enabled, environment, secret_ref, webhook_secret_ref,
      supports_card, supports_upi, supports_netbanking, supports_two_phase,
      supports_partial_capture, supports_partial_refund, supported_currencies,
      fee_bps, fee_fixed_minor, rate_limit_per_second, request_timeout_ms,
      breaker_failure_threshold, breaker_cooldown_seconds, breaker_half_open_max_probes
    ) VALUES
      ('razorpay', true, 'mock', 'env:RAZORPAY_API_KEY', 'env:RAZORPAY_WEBHOOK_SECRET',
       true, true, true, true, true, true, ARRAY['INR'], 200, 200, 200, 30000, 5, 30, 1),
      ('stripe', true, 'mock', 'env:STRIPE_API_KEY', 'env:STRIPE_WEBHOOK_SECRET',
       true, false, false, true, true, true, ARRAY['INR', 'USD', 'EUR'], 250, 300, 100, 30000, 5, 30, 1),
      ('payu', true, 'mock', 'env:PAYU_API_KEY', 'env:PAYU_WEBHOOK_SECRET',
       true, true, true, true, false, true, ARRAY['INR'], 180, 150, 150, 45000, 5, 30, 1),
      ('upi', true, 'mock', 'env:UPI_API_KEY', 'env:UPI_WEBHOOK_SECRET',
       false, true, false, false, false, false, ARRAY['INR'], 0, 0, 100, 60000, 5, 30, 1)
    ON CONFLICT (gateway_name) DO UPDATE SET
      enabled = EXCLUDED.enabled,
      environment = EXCLUDED.environment,
      supports_card = EXCLUDED.supports_card,
      supports_upi = EXCLUDED.supports_upi,
      supports_netbanking = EXCLUDED.supports_netbanking,
      supports_two_phase = EXCLUDED.supports_two_phase,
      supports_partial_capture = EXCLUDED.supports_partial_capture,
      supports_partial_refund = EXCLUDED.supports_partial_refund,
      fee_bps = EXCLUDED.fee_bps,
      fee_fixed_minor = EXCLUDED.fee_fixed_minor,
      rate_limit_per_second = EXCLUDED.rate_limit_per_second;
  `);

  // 3. Initial circuit breakers (CLOSED)
  const breakers = [
    { gateway: 'razorpay', method: 'CARD' },
    { gateway: 'razorpay', method: 'UPI' },
    { gateway: 'razorpay', method: 'NETBANKING' },
    { gateway: 'stripe', method: 'CARD' },
    { gateway: 'payu', method: 'CARD' },
    { gateway: 'payu', method: 'UPI' },
    { gateway: 'payu', method: 'NETBANKING' },
    { gateway: 'upi', method: 'UPI' }
  ];

  for (const b of breakers) {
    await knex.raw(
      `
      INSERT INTO gateway_circuit_breakers (gateway, payment_method, state, consecutive_failures)
      VALUES (?, ?, 'CLOSED', 0)
      ON CONFLICT (gateway, payment_method) DO UPDATE SET
        state = 'CLOSED',
        consecutive_failures = 0,
        opened_until = NULL,
        probe_lease_until = NULL,
        probe_owner = NULL;
    `,
      [b.gateway, b.method]
    );
  }

  // 4. Historical gateway performance dataset (PDF page 10)
  // Seed synthetic window dates for the 4 time bands
  const baseDate = '2026-11-08';
  const history = [
    // Razorpay
    { gateway: 'razorpay', method: 'CARD', start: `${baseDate}T03:00:00Z`, total: 4200, success: 4137, p95: 320, err: 63 },
    { gateway: 'razorpay', method: 'CARD', start: `${baseDate}T09:00:00Z`, total: 18500, success: 17982, p95: 450, err: 518 },
    { gateway: 'razorpay', method: 'CARD', start: `${baseDate}T15:00:00Z`, total: 32000, success: 30112, p95: 780, err: 1888 },
    { gateway: 'razorpay', method: 'CARD', start: `${baseDate}T21:00:00Z`, total: 25300, success: 24490, p95: 520, err: 810 },
    // Stripe
    { gateway: 'stripe', method: 'CARD', start: `${baseDate}T03:00:00Z`, total: 3800, success: 3766, p95: 280, err: 34 },
    { gateway: 'stripe', method: 'CARD', start: `${baseDate}T09:00:00Z`, total: 15200, success: 15018, p95: 310, err: 182 },
    { gateway: 'stripe', method: 'CARD', start: `${baseDate}T15:00:00Z`, total: 28500, success: 27788, p95: 420, err: 712 },
    { gateway: 'stripe', method: 'CARD', start: `${baseDate}T21:00:00Z`, total: 22100, success: 21702, p95: 350, err: 398 },
    // PayU
    { gateway: 'payu', method: 'CARD', start: `${baseDate}T03:00:00Z`, total: 2100, success: 2016, p95: 400, err: 84 },
    { gateway: 'payu', method: 'CARD', start: `${baseDate}T09:00:00Z`, total: 9800, success: 9163, p95: 620, err: 637 },
    { gateway: 'payu', method: 'CARD', start: `${baseDate}T15:00:00Z`, total: 15500, success: 13826, p95: 950, err: 1674 },
    { gateway: 'payu', method: 'CARD', start: `${baseDate}T21:00:00Z`, total: 12200, success: 11200, p95: 750, err: 1000 },
    // UPI
    { gateway: 'upi', method: 'UPI', start: `${baseDate}T03:00:00Z`, total: 5600, success: 5572, p95: 180, err: 28 },
    { gateway: 'upi', method: 'UPI', start: `${baseDate}T09:00:00Z`, total: 22000, success: 21824, p95: 210, err: 176 },
    { gateway: 'upi', method: 'UPI', start: `${baseDate}T15:00:00Z`, total: 38000, success: 37240, p95: 350, err: 760 },
    { gateway: 'upi', method: 'UPI', start: `${baseDate}T21:00:00Z`, total: 30500, success: 30134, p95: 250, err: 366 }
  ];

  for (const h of history) {
    await knex.raw(
      `
      INSERT INTO gateway_health_metrics (
        gateway, payment_method, window_start, recorded_at, total_count, success_count, p95_latency_ms, error_count
      ) VALUES (?, ?, ?, NOW(), ?, ?, ?, ?)
      ON CONFLICT (gateway, payment_method, window_start) DO UPDATE SET
        total_count = EXCLUDED.total_count,
        success_count = EXCLUDED.success_count,
        p95_latency_ms = EXCLUDED.p95_latency_ms,
        error_count = EXCLUDED.error_count;
    `,
      [h.gateway, h.method, h.start, h.total, h.success, h.p95, h.err]
    );
  }
}

