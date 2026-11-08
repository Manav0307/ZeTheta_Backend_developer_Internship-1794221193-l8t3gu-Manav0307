import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false, // run sequentially to avoid port / db collision
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://postgres:postgres@localhost:54332/zetheta_test',
      TEST_DATABASE_URL: 'postgres://postgres:postgres@localhost:54332/zetheta_test',
      DB_NAME: 'zetheta_test'
    }
  }
});

