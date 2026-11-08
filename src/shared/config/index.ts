import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  PORT: z.string().default('3000').transform((v) => parseInt(v, 10)),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  DATABASE_URL: z.string().default('postgres://postgres:postgres@localhost:54332/zetheta_dev'),
  TEST_DATABASE_URL: z.string().default('postgres://postgres:postgres@localhost:54332/zetheta_test'),
  DB_HOST: z.string().default('localhost'),
  DB_PORT: z.string().default('54332').transform((v) => parseInt(v, 10)),
  DB_USER: z.string().default('postgres'),
  DB_PASSWORD: z.string().default('postgres'),
  DB_NAME: z.string().default('zetheta_dev'),
  TEST_DB_NAME: z.string().default('zetheta_test'),
  ADMIN_API_KEY: z.string().default('admin-secret-key-12345'),
  MERCHANT_API_KEY: z.string().default('merchant-secret-key-67890'),
  RAZORPAY_WEBHOOK_SECRET: z.string().default('mock-razorpay-secret'),
  STRIPE_WEBHOOK_SECRET: z.string().default('mock-stripe-secret'),
  PAYU_WEBHOOK_SECRET: z.string().default('mock-payu-secret'),
  UPI_WEBHOOK_SECRET: z.string().default('mock-upi-secret'),
  RECONCILIATION_INTERVAL_MINUTES: z.string().default('15').transform((v) => parseInt(v, 10)),
  RECONCILIATION_STALE_MINUTES: z.string().default('5').transform((v) => parseInt(v, 10)),
  WEBHOOK_WORKER_POLL_INTERVAL_MS: z.string().default('1000').transform((v) => parseInt(v, 10)),
});

export const config = envSchema.parse(process.env);
export type Config = z.infer<typeof envSchema>;

