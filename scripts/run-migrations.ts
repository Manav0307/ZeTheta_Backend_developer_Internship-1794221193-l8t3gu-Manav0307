import knex from 'knex';
import knexConfig from '../src/database/knexfile.js';
import dotenv from 'dotenv';

dotenv.config();

const env = process.env.NODE_ENV || 'development';
const config = knexConfig[env] || knexConfig.development;

async function runMigrations() {
  const db = knex(config);
  try {
    console.log(`Running Knex migrations for environment: ${env}...`);
    const [batchNo, log] = await db.migrate.latest({
      directory: './src/database/migrations',
      extension: 'ts'
    });
    console.log(`Migrations complete. Batch ${batchNo} ran:`, log);
  } finally {
    await db.destroy();
  }
}

runMigrations().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});

