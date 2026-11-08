import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS reconciliation_runs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        trigger_source VARCHAR(16) NOT NULL CHECK (trigger_source IN ('SCHEDULED','MANUAL')),
        status VARCHAR(16) NOT NULL DEFAULT 'RUNNING'
          CHECK (status IN ('RUNNING','COMPLETED','FAILED')),
        scanned_count INTEGER NOT NULL DEFAULT 0 CHECK (scanned_count >= 0),
        mismatch_count INTEGER NOT NULL DEFAULT 0 CHECK (mismatch_count >= 0),
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        trace_id UUID NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reconciliation_log (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id UUID NOT NULL REFERENCES reconciliation_runs(id) ON DELETE RESTRICT,
        transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE RESTRICT,
        attempt_id UUID,
        gateway VARCHAR(50) NOT NULL REFERENCES gateway_config(gateway_name),
        internal_state VARCHAR(32) NOT NULL,
        provider_state VARCHAR(100),
        discrepancy_type VARCHAR(100),
        action VARCHAR(100) NOT NULL,
        outcome VARCHAR(20) NOT NULL CHECK (outcome IN ('MATCH','CORRECTED','ANOMALY','ERROR')),
        details JSONB NOT NULL DEFAULT '{}'::JSONB,
        trace_id UUID NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        FOREIGN KEY (attempt_id, transaction_id)
          REFERENCES payment_attempts(id, transaction_id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_reconciliation_log_run ON reconciliation_log(run_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_reconciliation_log_tx ON reconciliation_log(transaction_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS reconciliation_anomalies (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id UUID REFERENCES reconciliation_runs(id) ON DELETE RESTRICT,
        transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE RESTRICT,
        reconciliation_log_id UUID REFERENCES reconciliation_log(id) ON DELETE RESTRICT,
        severity VARCHAR(12) NOT NULL CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
        status VARCHAR(20) NOT NULL DEFAULT 'OPEN'
          CHECK (status IN ('OPEN','INVESTIGATING','RESOLVED')),
        anomaly_type VARCHAR(100) NOT NULL,
        description TEXT NOT NULL,
        trace_id UUID NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resolved_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS idx_reconciliation_anomalies_open ON reconciliation_anomalies(severity, created_at)
      WHERE status != 'RESOLVED';
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    DROP TABLE IF EXISTS reconciliation_anomalies CASCADE;
    DROP TABLE IF EXISTS reconciliation_log CASCADE;
    DROP TABLE IF EXISTS reconciliation_runs CASCADE;
  `);
}

