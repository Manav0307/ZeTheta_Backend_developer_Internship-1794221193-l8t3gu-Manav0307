import type { Knex } from 'knex';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

const connection =
  process.env.NODE_ENV === 'test'
    ? process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@localhost:54332/zetheta_test'
    : process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:54332/zetheta_dev';

const knexConfig: { [key: string]: Knex.Config } = {
  development: {
    client: 'pg',
    connection,
    migrations: {
      directory: path.resolve(__dirname, 'migrations'),
      extension: 'ts',
      tableName: 'knex_migrations'
    },
    seeds: {
      directory: path.resolve(__dirname, 'seeds'),
      extension: 'ts'
    }
  },
  test: {
    client: 'pg',
    connection: process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@localhost:54332/zetheta_test',
    migrations: {
      directory: path.resolve(__dirname, 'migrations'),
      extension: 'ts',
      tableName: 'knex_migrations'
    },
    seeds: {
      directory: path.resolve(__dirname, 'seeds'),
      extension: 'ts'
    }
  },
  production: {
    client: 'pg',
    connection: process.env.DATABASE_URL,
    migrations: {
      directory: path.resolve(__dirname, 'migrations'),
      extension: 'js',
      tableName: 'knex_migrations'
    }
  }
};

export default knexConfig;

