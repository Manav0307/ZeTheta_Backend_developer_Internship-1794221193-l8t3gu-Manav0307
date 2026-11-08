import knex from 'knex';
import knexConfig from '../src/database/knexfile.js';
import dotenv from 'dotenv';

dotenv.config();

const env = process.env.NODE_ENV || 'development';
const config = knexConfig[env] || knexConfig.development;

async function runRollback() {
  const db = knex(config);
  try {
    console.log(`Rolling back latest migration batch for environment: ${env}...`);
    const [batchNo, log] = await db.migrate.rollback({
      directory: './src/database/migrations',
      extension: 'ts'
    });
    console.log(`Rollback complete. Batch ${batchNo} rolled back:`, log);
  } finally {
    await db.destroy();
  }
}

runRollback().catch((err) => {
  console.error('Rollback failed:', err);
  process.exit(1);
});

