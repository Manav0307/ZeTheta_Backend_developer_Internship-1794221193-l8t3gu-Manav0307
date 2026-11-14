import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    -- C1: Persistent Asynchronous Retry Queue (PDF-C p.35)
    CREATE TABLE IF NOT EXISTS payment_retry_queue (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE RESTRICT,
        attempt_id UUID REFERENCES payment_attempts(id) ON DELETE RESTRICT,
        action VARCHAR(50) NOT NULL,
        retry_count INT NOT NULL DEFAULT 0,
        max_retries INT NOT NULL DEFAULT 3,
        next_retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        lease_expires_at TIMESTAMPTZ,
        status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'DLQ')),
        error_message TEXT,
        payload JSONB NOT NULL DEFAULT '{}'::JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_payment_retry_queue_pending ON payment_retry_queue(status, next_retry_at)
      WHERE status IN ('PENDING', 'FAILED');

    -- C2: Settlement Batch Tracking (PDF-C p.36)
    CREATE TABLE IF NOT EXISTS settlement_batches (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        batch_reference VARCHAR(100) NOT NULL UNIQUE,
        gateway VARCHAR(50) NOT NULL REFERENCES gateway_config(gateway_name),
        total_transactions INT NOT NULL DEFAULT 0,
        total_amount_minor NUMERIC(16, 0) NOT NULL DEFAULT 0,
        currency VARCHAR(3) NOT NULL DEFAULT 'INR',
        status VARCHAR(50) NOT NULL DEFAULT 'RECONCILED',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Extend transactions with explicit settlement batch tracking
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS settlement_batch_id UUID REFERENCES settlement_batches(id);
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS settlement_status VARCHAR(50) NOT NULL DEFAULT 'PENDING';
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE transactions DROP COLUMN IF EXISTS settlement_status;
    ALTER TABLE transactions DROP COLUMN IF EXISTS settlement_batch_id;
    DROP TABLE IF EXISTS settlement_batches CASCADE;
    DROP TABLE IF EXISTS payment_retry_queue CASCADE;
  `);
}

