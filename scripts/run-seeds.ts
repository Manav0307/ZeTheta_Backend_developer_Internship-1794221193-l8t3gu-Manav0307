import knex from 'knex';
import knexConfig from '../src/database/knexfile.js';
import dotenv from 'dotenv';

dotenv.config();

const env = process.env.NODE_ENV || 'development';
const config = knexConfig[env] || knexConfig.development;

async function runSeeds() {
  const db = knex(config);
  try {
    console.log(`Running Knex seeds for environment: ${env}...`);
    const [log] = await db.seed.run({
      directory: './src/database/seeds',
      extension: 'ts'
    });
    console.log('Seeds complete. Seed files executed:', log);
  } finally {
    await db.destroy();
  }
}

runSeeds().catch((err) => {
  console.error('Seed execution failed:', err);
  process.exit(1);
});

