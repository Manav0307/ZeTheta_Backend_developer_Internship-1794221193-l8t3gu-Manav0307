import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS transactions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        merchant_id VARCHAR(100) NOT NULL,
        merchant_order_id VARCHAR(255) NOT NULL,
        payment_method VARCHAR(24) NOT NULL
          CHECK (payment_method IN ('CARD','UPI','NETBANKING')),
        currency VARCHAR(3) NOT NULL DEFAULT 'INR',
        amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
        capture_mode VARCHAR(16) NOT NULL DEFAULT 'MANUAL'
          CHECK (capture_mode IN ('MANUAL','AUTOMATIC')),
        state VARCHAR(32) NOT NULL DEFAULT 'CREATED'
          CHECK (state IN (
            'CREATED','ROUTE_SELECTED','AUTH_INITIATED','AUTHORISED','AUTH_FAILED',
            'AUTH_TIMEOUT','ROUTE_FAILED','CAPTURE_INITIATED','CAPTURED',
            'PARTIALLY_CAPTURED','CAPTURE_FAILED','REFUND_INITIATED',
            'PARTIALLY_REFUNDED','REFUND_FAILED','REFUNDED','FAILED',
            'ABANDONED','VOID_INITIATED','VOIDED','AUTH_EXPIRED',
            'SETTLED','DISPUTE_OPENED','DISPUTE_RESOLVED'
          )),
        authorized_minor BIGINT NOT NULL DEFAULT 0 CHECK (authorized_minor >= 0),
        captured_minor BIGINT NOT NULL DEFAULT 0 CHECK (captured_minor >= 0),
        refunded_minor BIGINT NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0),
        reserved_refund_minor BIGINT NOT NULL DEFAULT 0 CHECK (reserved_refund_minor >= 0),
        version BIGINT NOT NULL DEFAULT 0 CHECK (version >= 0),
        trace_id UUID NOT NULL,
        last_error_code VARCHAR(100),
        metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (merchant_id, merchant_order_id),
        CHECK (authorized_minor <= amount_minor),
        CHECK (captured_minor <= authorized_minor),
        CHECK (refunded_minor + reserved_refund_minor <= captured_minor)
    );

    CREATE TABLE IF NOT EXISTS payment_attempts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE RESTRICT,
        gateway VARCHAR(50) NOT NULL REFERENCES gateway_config(gateway_name),
        attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
        status VARCHAR(20) NOT NULL DEFAULT 'CREATED'
          CHECK (status IN ('CREATED','SENT','UNKNOWN','AUTHORISED','CAPTURED','FAILED','VOIDED')),
        provider_payment_ref VARCHAR(255),
        provider_order_ref VARCHAR(255),
        provider_idempotency_key VARCHAR(255),
        amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
        request_dispatched_at TIMESTAMPTZ,
        resolved_at TIMESTAMPTZ,
        error_class VARCHAR(40),
        error_code VARCHAR(100),
        trace_id UUID NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (transaction_id, attempt_no),
        UNIQUE (id, transaction_id),
        UNIQUE (gateway, provider_payment_ref),
        UNIQUE (gateway, provider_order_ref),
        UNIQUE (gateway, provider_idempotency_key)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_attempts_one_active
      ON payment_attempts(transaction_id)
      WHERE status IN ('CREATED','SENT','UNKNOWN','AUTHORISED');

    CREATE INDEX IF NOT EXISTS idx_transactions_state_created ON transactions(state, created_at);
    CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at);
    CREATE INDEX IF NOT EXISTS idx_transactions_trace_id ON transactions(trace_id);
    CREATE INDEX IF NOT EXISTS idx_payment_attempts_tx_created ON payment_attempts(transaction_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_payment_attempts_gateway_status ON payment_attempts(gateway, status);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    DROP TABLE IF EXISTS payment_attempts CASCADE;
    DROP TABLE IF EXISTS transactions CASCADE;
  `);
}

