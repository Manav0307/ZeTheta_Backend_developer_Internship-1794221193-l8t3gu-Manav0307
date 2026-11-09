import { getPool, closePool } from '../src/database/connection.js';

async function main() {
  const pool = getPool();
  await pool.query("UPDATE gateway_circuit_breakers SET state = 'CLOSED', consecutive_failures = 0, opened_until = NULL;");
  console.log('Reset breakers successfully.');
  await closePool();
}

main().catch(console.error);

