import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS processed_webhook_events (
        gateway VARCHAR(50) NOT NULL REFERENCES gateway_config(gateway_name),
        event_id VARCHAR(255) NOT NULL,
        event_type VARCHAR(100) NOT NULL,
        payload_hash VARCHAR(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
        transaction_id UUID REFERENCES transactions(id) ON DELETE RESTRICT,
        attempt_id UUID,
        status VARCHAR(16) NOT NULL DEFAULT 'RECEIVED'
          CHECK (status IN ('RECEIVED','PROCESSED','DLQ')),
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        processed_at TIMESTAMPTZ,
        PRIMARY KEY (gateway, event_id),
        FOREIGN KEY (attempt_id, transaction_id)
          REFERENCES payment_attempts(id, transaction_id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_webhook_events_transaction ON processed_webhook_events(transaction_id);

    CREATE TABLE IF NOT EXISTS webhook_queue (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        gateway VARCHAR(50) NOT NULL,
        event_id VARCHAR(255) NOT NULL,
        transaction_id UUID REFERENCES transactions(id) ON DELETE RESTRICT,
        attempt_id UUID,
        payload JSONB NOT NULL,
        signature_digest VARCHAR(64),
        status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
          CHECK (status IN ('PENDING','PROCESSING','COMPLETED','FAILED','DLQ')),
        retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
        max_retries INTEGER NOT NULL DEFAULT 3 CHECK (max_retries >= 0),
        next_retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        lease_owner UUID,
        lease_expires_at TIMESTAMPTZ,
        error_message TEXT,
        trace_id UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        processed_at TIMESTAMPTZ,
        FOREIGN KEY (gateway, event_id)
          REFERENCES processed_webhook_events(gateway, event_id) ON DELETE RESTRICT,
        FOREIGN KEY (attempt_id, transaction_id)
          REFERENCES payment_attempts(id, transaction_id) ON DELETE RESTRICT,
        UNIQUE (gateway, event_id)
    );

    CREATE INDEX IF NOT EXISTS idx_webhook_queue_ready ON webhook_queue(next_retry_at, id)
      WHERE status IN ('PENDING','FAILED');
    CREATE INDEX IF NOT EXISTS idx_webhook_queue_expired_lease ON webhook_queue(lease_expires_at)
      WHERE status = 'PROCESSING';
    CREATE INDEX IF NOT EXISTS idx_webhook_queue_dlq ON webhook_queue(created_at)
      WHERE status = 'DLQ';
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    DROP TABLE IF EXISTS webhook_queue CASCADE;
    DROP TABLE IF EXISTS processed_webhook_events CASCADE;
  `);
}

