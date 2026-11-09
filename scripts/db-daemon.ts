import EmbeddedPostgres from 'embedded-postgres';
import { Client } from 'pg';
import path from 'path';
import os from 'os';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

const DB_DIR = path.resolve(process.env.LOCALAPPDATA || os.homedir(), 'zetheta_pgdata');
const PORT = parseInt(process.env.DB_PORT || '54332', 10);
const USER = process.env.DB_USER || 'postgres';
const PASSWORD = process.env.DB_PASSWORD || 'postgres';

async function main() {
  console.log(`Starting EmbeddedPostgres on port ${PORT}...`);
  const pg = new (EmbeddedPostgres as any)({
    databaseDir: DB_DIR,
    user: USER,
    password: PASSWORD,
    port: PORT,
    persistent: true,
    autoRehydrateSymlinks: true,
    onLog: (msg: any) => console.log('[pg]', msg),
    onError: (err: any) => console.error('[pg err]', err)
  });

  if (!fs.existsSync(DB_DIR)) {
    console.log('Initializing cluster...');
    await pg.initialise();
  }

  await pg.start();
  console.log(`EmbeddedPostgres successfully started and listening on port ${PORT}.`);

  // Ensure dev and test databases exist
  const adminClient = new Client({
    host: 'localhost',
    port: PORT,
    user: USER,
    password: PASSWORD,
    database: 'postgres'
  });
  await adminClient.connect();

  const devDb = process.env.DB_NAME || 'zetheta_dev';
  const testDb = process.env.TEST_DB_NAME || 'zetheta_test';

  for (const db of [devDb, testDb]) {
    const checkRes = await adminClient.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      [db]
    );
    if (checkRes.rowCount === 0) {
      await adminClient.query(`CREATE DATABASE "${db}"`);
      console.log(`Created database: ${db}`);
    }
  }
  await adminClient.end();
  console.log('Databases verified. Postgres daemon ready.');

  // Keep process alive indefinitely with active timer
  setInterval(() => {}, 1000 * 60 * 60);
}

main().catch((err) => {
  console.error('Fatal error starting Postgres daemon:', err);
  process.exit(1);
});

