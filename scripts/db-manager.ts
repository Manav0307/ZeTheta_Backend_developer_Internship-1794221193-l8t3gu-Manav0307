import EmbeddedPostgres from 'embedded-postgres';
import { Client } from 'pg';
import path from 'path';
import fs from 'fs';
import os from 'os';
import dotenv from 'dotenv';

dotenv.config();

// Store outside OneDrive to avoid file-locking / sync issues
const DB_DIR = path.resolve(process.env.LOCALAPPDATA || os.homedir(), 'zetheta_pgdata');
const PORT = parseInt(process.env.DB_PORT || '54332', 10);
const USER = process.env.DB_USER || 'postgres';
const PASSWORD = process.env.DB_PASSWORD || 'postgres';

let pgInstance: any = null;

export function getPostgresInstance() {
  if (!pgInstance) {
    pgInstance = new (EmbeddedPostgres as any)({
      databaseDir: DB_DIR,
      user: USER,
      password: PASSWORD,
      port: PORT,
      persistent: true,
      autoRehydrateSymlinks: true
    });
  }
  return pgInstance;
}

export async function ensurePostgresRunning() {
  // First check if port is already listening and responsive
  try {
    const testClient = new Client({
      host: 'localhost',
      port: PORT,
      user: USER,
      password: PASSWORD,
      database: 'postgres'
    });
    await testClient.connect();
    await testClient.end();
    return;
  } catch {
    // Port not open or db not running, proceed to start
  }

  const pg = getPostgresInstance();
  const isFirstTime = !fs.existsSync(DB_DIR);
  if (isFirstTime) {
    await pg.initialise();
  }
  await pg.start();

  // Create default and test databases if they do not exist
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
    }
  }

  await adminClient.end();
}

export async function stopPostgres() {
  try {
    const pg = getPostgresInstance();
    await pg.stop();
  } catch {}
}
