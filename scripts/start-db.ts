import { ensurePostgresRunning } from './db-manager.js';

async function main() {
  console.log('Ensuring local PostgreSQL is running...');
  await ensurePostgresRunning();
  console.log('PostgreSQL is running and databases are ready.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Failed to start Postgres:', err);
  process.exit(1);
});
