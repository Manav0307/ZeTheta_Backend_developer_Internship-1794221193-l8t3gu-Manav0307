import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE OR REPLACE FUNCTION forbid_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'transaction_state_log is append-only';
    END;
    $$;

    DROP TRIGGER IF EXISTS trg_state_log_immutable ON transaction_state_log;
    CREATE TRIGGER trg_state_log_immutable
      BEFORE UPDATE OR DELETE ON transaction_state_log
      FOR EACH ROW EXECUTE FUNCTION forbid_audit_mutation();
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    DROP TRIGGER IF EXISTS trg_state_log_immutable ON transaction_state_log;
    DROP FUNCTION IF EXISTS forbid_audit_mutation();
  `);
}

