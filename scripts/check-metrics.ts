import { getPool, closePool } from '../src/database/connection.js';

async function main() {
  const pool = getPool();
  const res = await pool.query('SELECT gateway, payment_method, success_count, total_count FROM gateway_health_metrics WHERE payment_method = \'CARD\'');
  console.table(res.rows);
  await closePool();
}

main().catch(console.error);

