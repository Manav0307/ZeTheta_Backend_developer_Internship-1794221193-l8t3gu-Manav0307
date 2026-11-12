import { ensurePostgresRunning } from './db-manager';

async function main() {
  console.log('Starting Postgres daemon...');
  await ensurePostgresRunning();
  console.log('POSTGRES_READY on port 54332');
  // Keep process open
  setInterval(() => {}, 60000);
}

main().catch(err => {
  console.error('Error starting db daemon:', err);
  process.exit(1);
});

