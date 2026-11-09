import crypto from 'crypto';
import { config } from '../../shared/config/index.js';

export class MockSignatures {
  /**
   * Generates a valid HMAC-SHA256 signature for Razorpay webhooks
   */
  static generateRazorpaySignature(rawBody: string | Buffer, secret: string = config.RAZORPAY_WEBHOOK_SECRET): string {
    const bodyStr = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
    return crypto.createHmac('sha256', secret).update(bodyStr).digest('hex');
  }

  /**
   * Generates a valid Stripe signature header: t=<timestamp>,v1=<signature>
   */
  static generateStripeSignature(rawBody: string | Buffer, secret: string = config.STRIPE_WEBHOOK_SECRET, timestamp?: number): string {
    const t = timestamp || Math.floor(Date.now() / 1000);
    const bodyStr = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
    const payload = `${t}.${bodyStr}`;
    const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    return `t=${t},v1=${sig}`;
  }

  /**
   * Generates a valid PayU SHA-512 hash
   * Format: sha512(salt|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key)
   */
  static generatePayUHash(params: {
    txnid: string;
    amount: string;
    productinfo: string;
    firstname: string;
    email: string;
    status: string;
    salt?: string;
    key?: string;
  }): string {
    const salt = params.salt || config.PAYU_WEBHOOK_SECRET;
    const key = params.key || 'payu_merchant_key';
    const hashString = `${salt}|${params.status}|||||||||||${params.email}|${params.firstname}|${params.productinfo}|${params.amount}|${params.txnid}|${key}`;
    return crypto.createHash('sha512').update(hashString).digest('hex');
  }

  /**
   * Generates a valid HMAC-SHA256 signature for UPI webhooks
   */
  static generateUpiSignature(rawBody: string | Buffer, secret: string = config.UPI_WEBHOOK_SECRET): string {
    const bodyStr = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
    return crypto.createHmac('sha256', secret).update(bodyStr).digest('hex');
  }
}

