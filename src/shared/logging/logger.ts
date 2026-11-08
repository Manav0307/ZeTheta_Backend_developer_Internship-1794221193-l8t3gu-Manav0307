import pino from 'pino';
import { config } from '../config/index.js';

export const logger = pino({
  level: config.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-api-key"]',
      'req.headers["stripe-signature"]',
      'req.headers["x-razorpay-signature"]',
      'card_number',
      'pan',
      'cvv',
      'cardholder_name',
      'upi_pin',
      'password',
      'secret'
    ],
    remove: false,
    censor: '[REDACTED]'
  },
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level(label) {
      return { level: label.toUpperCase() };
    }
  }
});

export function createChildLogger(bindings: {
  trace_id?: string;
  transaction_id?: string;
  component?: string;
  action?: string;
  gateway?: string;
  [key: string]: any;
}) {
  return logger.child(bindings);
}

