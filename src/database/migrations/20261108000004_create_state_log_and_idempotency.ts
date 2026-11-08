import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS transaction_state_log (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE RESTRICT,
        attempt_id UUID,
        from_state VARCHAR(32),
        to_state VARCHAR(32) NOT NULL,
        event VARCHAR(100) NOT NULL,
        gateway_reference VARCHAR(255),
        gateway_response JSONB NOT NULL DEFAULT '{}'::JSONB,
        metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
        trace_id UUID NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_by VARCHAR(100) NOT NULL,
        FOREIGN KEY (attempt_id, transaction_id)
          REFERENCES payment_attempts(id, transaction_id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_state_log_tx_created ON transaction_state_log(transaction_id, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_state_log_transition ON transaction_state_log(from_state, to_state);
    CREATE INDEX IF NOT EXISTS idx_state_log_trace ON transaction_state_log(trace_id);

    CREATE TABLE IF NOT EXISTS idempotency_keys (
        merchant_id VARCHAR(100) NOT NULL,
        operation VARCHAR(40) NOT NULL
          CHECK (operation IN ('PAYMENT_CREATE','CAPTURE','VOID','REFUND')),
        key VARCHAR(255) NOT NULL,
        request_hash VARCHAR(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
        transaction_id UUID REFERENCES transactions(id) ON DELETE RESTRICT,
        status VARCHAR(20) NOT NULL DEFAULT 'PROCESSING'
          CHECK (status IN ('PROCESSING','COMPLETED','FAILED','UNKNOWN')),
        response_code INTEGER CHECK (response_code BETWEEN 100 AND 599),
        response_body JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
        PRIMARY KEY (merchant_id, operation, key)
    );

    CREATE INDEX IF NOT EXISTS idx_idempotency_expiry ON idempotency_keys(expires_at);
    CREATE INDEX IF NOT EXISTS idx_idempotency_transaction ON idempotency_keys(transaction_id);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    DROP TABLE IF EXISTS idempotency_keys CASCADE;
    DROP TABLE IF EXISTS transaction_state_log CASCADE;
  `);
}

