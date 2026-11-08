import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS gateway_config (
        gateway_name VARCHAR(50) PRIMARY KEY,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        environment VARCHAR(12) NOT NULL DEFAULT 'mock'
          CHECK (environment IN ('mock','sandbox','live')),
        secret_ref TEXT,
        webhook_secret_ref TEXT,
        supports_card BOOLEAN NOT NULL DEFAULT FALSE,
        supports_upi BOOLEAN NOT NULL DEFAULT FALSE,
        supports_netbanking BOOLEAN NOT NULL DEFAULT FALSE,
        supports_two_phase BOOLEAN NOT NULL DEFAULT FALSE,
        supports_partial_capture BOOLEAN NOT NULL DEFAULT FALSE,
        supports_partial_refund BOOLEAN NOT NULL DEFAULT FALSE,
        supported_currencies TEXT[] NOT NULL DEFAULT ARRAY['INR']::TEXT[],
        fee_bps INTEGER NOT NULL DEFAULT 0 CHECK (fee_bps >= 0),
        fee_fixed_minor BIGINT NOT NULL DEFAULT 0 CHECK (fee_fixed_minor >= 0),
        rate_limit_per_second INTEGER NOT NULL DEFAULT 100 CHECK (rate_limit_per_second > 0),
        request_timeout_ms INTEGER NOT NULL DEFAULT 30000 CHECK (request_timeout_ms > 0),
        breaker_failure_threshold INTEGER NOT NULL DEFAULT 5 CHECK (breaker_failure_threshold > 0),
        breaker_cooldown_seconds INTEGER NOT NULL DEFAULT 30 CHECK (breaker_cooldown_seconds > 0),
        breaker_half_open_max_probes INTEGER NOT NULL DEFAULT 1 CHECK (breaker_half_open_max_probes > 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS routing_config (
        id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
        weight_success NUMERIC(6,5) NOT NULL DEFAULT 0.35000,
        weight_latency NUMERIC(6,5) NOT NULL DEFAULT 0.20000,
        weight_cost NUMERIC(6,5) NOT NULL DEFAULT 0.20000,
        weight_health NUMERIC(6,5) NOT NULL DEFAULT 0.15000,
        weight_method_fit NUMERIC(6,5) NOT NULL DEFAULT 0.10000,
        metric_window_minutes INTEGER NOT NULL DEFAULT 15 CHECK (metric_window_minutes > 0),
        degraded_preference_threshold NUMERIC(6,5) NOT NULL DEFAULT 0.20000
          CHECK (degraded_preference_threshold BETWEEN 0 AND 1),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (weight_success BETWEEN 0 AND 1),
        CHECK (weight_latency BETWEEN 0 AND 1),
        CHECK (weight_cost BETWEEN 0 AND 1),
        CHECK (weight_health BETWEEN 0 AND 1),
        CHECK (weight_method_fit BETWEEN 0 AND 1),
        CHECK (weight_success + weight_latency + weight_cost + weight_health + weight_method_fit = 1.00000)
    );
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    DROP TABLE IF EXISTS routing_config CASCADE;
    DROP TABLE IF EXISTS gateway_config CASCADE;
  `);
}

