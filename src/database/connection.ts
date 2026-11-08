import pg from 'pg';
import { config } from '../shared/config/index.js';
import { logger } from '../shared/logging/logger.js';

const { Pool, types } = pg;

// Parse PostgreSQL BIGINT (type id 20) as string by default, or safe BigInt handling
types.setTypeParser(20, (val: string) => val);

let pool: pg.Pool | null = null;

export function getPool(customConnectionString?: string): pg.Pool {
  if (!pool) {
    const connectionString =
      customConnectionString ||
      (process.env.NODE_ENV === 'test'
        ? config.TEST_DATABASE_URL
        : config.DATABASE_URL);

    pool = new Pool({
      connectionString,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    pool.on('error', (err) => {
      logger.error({ err }, 'Unexpected error on idle PostgreSQL client');
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export async function query<R extends pg.QueryResultRow = any>(
  text: string,
  params?: any[]
): Promise<pg.QueryResult<R>> {
  const p = getPool();
  return p.query<R>(text, params);
}

export async function withTransaction<T>(
  callback: (client: pg.PoolClient) => Promise<T>,
  existingClient?: pg.PoolClient
): Promise<T> {
  if (existingClient) {
    return callback(existingClient);
  }

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      logger.error({ rollbackErr }, 'Failed to rollback transaction');
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function checkDatabaseHealth(): Promise<{
  healthy: boolean;
  database: string;
  latency_ms: number;
  error?: string;
}> {
  const start = Date.now();
  try {
    const res = await query('SELECT current_database() as db');
    return {
      healthy: true,
      database: res.rows[0].db,
      latency_ms: Date.now() - start
    };
  } catch (err: any) {
    return {
      healthy: false,
      database: 'unknown',
      latency_ms: Date.now() - start,
      error: err.message
    };
  }
}
