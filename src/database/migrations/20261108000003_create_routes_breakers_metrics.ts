import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS gateway_routes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE RESTRICT,
        attempt_id UUID,
        gateway VARCHAR(50) NOT NULL REFERENCES gateway_config(gateway_name),
        routing_config_revision BIGINT NOT NULL CHECK (routing_config_revision > 0),
        selected BOOLEAN NOT NULL DEFAULT FALSE,
        score NUMERIC(10,8) NOT NULL CHECK (score BETWEEN 0 AND 1),
        normalized_success NUMERIC(10,8) NOT NULL CHECK (normalized_success BETWEEN 0 AND 1),
        normalized_latency NUMERIC(10,8) NOT NULL CHECK (normalized_latency BETWEEN 0 AND 1),
        normalized_cost NUMERIC(10,8) NOT NULL CHECK (normalized_cost BETWEEN 0 AND 1),
        health_score NUMERIC(10,8) NOT NULL CHECK (health_score BETWEEN 0 AND 1),
        method_fit_score NUMERIC(10,8) NOT NULL CHECK (method_fit_score BETWEEN 0 AND 1),
        reason JSONB NOT NULL DEFAULT '{}'::JSONB,
        trace_id UUID NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        FOREIGN KEY (attempt_id, transaction_id)
          REFERENCES payment_attempts(id, transaction_id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_gateway_routes_tx_created ON gateway_routes(transaction_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_gateway_routes_gateway_score ON gateway_routes(gateway, score DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_gateway_routes_one_selected_per_attempt
      ON gateway_routes(attempt_id) WHERE selected = TRUE AND attempt_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS gateway_circuit_breakers (
        gateway VARCHAR(50) NOT NULL REFERENCES gateway_config(gateway_name),
        payment_method VARCHAR(24) NOT NULL CHECK (payment_method IN ('CARD','UPI','NETBANKING')),
        state VARCHAR(12) NOT NULL DEFAULT 'CLOSED'
          CHECK (state IN ('CLOSED','OPEN','HALF_OPEN')),
        consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
        opened_until TIMESTAMPTZ,
        probe_lease_until TIMESTAMPTZ,
        probe_owner UUID,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (gateway, payment_method)
    );

    CREATE TABLE IF NOT EXISTS gateway_health_metrics (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        gateway VARCHAR(50) NOT NULL REFERENCES gateway_config(gateway_name),
        payment_method VARCHAR(24) NOT NULL CHECK (payment_method IN ('CARD','UPI','NETBANKING')),
        window_start TIMESTAMPTZ NOT NULL,
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        total_count BIGINT NOT NULL DEFAULT 0 CHECK (total_count >= 0),
        success_count BIGINT NOT NULL DEFAULT 0 CHECK (success_count >= 0),
        p95_latency_ms INTEGER CHECK (p95_latency_ms >= 0),
        error_count BIGINT NOT NULL DEFAULT 0 CHECK (error_count >= 0),
        CHECK (success_count <= total_count),
        CHECK (error_count <= total_count),
        UNIQUE (gateway, payment_method, window_start)
    );

    CREATE INDEX IF NOT EXISTS idx_gateway_health_gateway_recorded
      ON gateway_health_metrics(gateway, payment_method, recorded_at DESC);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    DROP TABLE IF EXISTS gateway_health_metrics CASCADE;
    DROP TABLE IF EXISTS gateway_circuit_breakers CASCADE;
    DROP TABLE IF EXISTS gateway_routes CASCADE;
  `);
}

