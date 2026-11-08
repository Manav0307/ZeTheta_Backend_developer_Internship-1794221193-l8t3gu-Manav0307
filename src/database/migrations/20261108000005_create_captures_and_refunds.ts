import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS capture_operations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE RESTRICT,
        attempt_id UUID NOT NULL,
        operation_key VARCHAR(255) NOT NULL,
        amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
        status VARCHAR(24) NOT NULL DEFAULT 'PENDING'
          CHECK (status IN ('PENDING','SENT','UNKNOWN','SUCCEEDED','FAILED')),
        provider_capture_ref VARCHAR(255),
        trace_id UUID NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        FOREIGN KEY (attempt_id, transaction_id)
          REFERENCES payment_attempts(id, transaction_id) ON DELETE RESTRICT,
        UNIQUE (transaction_id, operation_key)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS uq_capture_provider_ref
      ON capture_operations(attempt_id, provider_capture_ref)
      WHERE provider_capture_ref IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_capture_tx_status ON capture_operations(transaction_id, status);

    CREATE TABLE IF NOT EXISTS refunds (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE RESTRICT,
        attempt_id UUID NOT NULL,
        operation_key VARCHAR(255) NOT NULL,
        amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
        currency VARCHAR(3) NOT NULL DEFAULT 'INR',
        status VARCHAR(24) NOT NULL DEFAULT 'PENDING'
          CHECK (status IN ('PENDING','SENT','UNKNOWN','SUCCEEDED','FAILED')),
        gateway_refund_id VARCHAR(255),
        reason VARCHAR(255),
        trace_id UUID NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        FOREIGN KEY (attempt_id, transaction_id)
          REFERENCES payment_attempts(id, transaction_id) ON DELETE RESTRICT,
        UNIQUE (transaction_id, operation_key)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS uq_refunds_provider_ref
      ON refunds(attempt_id, gateway_refund_id)
      WHERE gateway_refund_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_refunds_tx_status ON refunds(transaction_id, status);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    DROP TABLE IF EXISTS refunds CASCADE;
    DROP TABLE IF EXISTS capture_operations CASCADE;
  `);
}

