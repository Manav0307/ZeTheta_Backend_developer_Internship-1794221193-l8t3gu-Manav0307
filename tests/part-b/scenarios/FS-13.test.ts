import { describe, it, expect } from 'vitest';
import { PaymentApplicationService } from '../../../src/modules/payments/payment.service.js';
import { getPool } from '../../../src/database/connection.js';
import { v4 as uuidv4 } from 'uuid';

describe('FS-13: Multi-Tenant Idempotency Key Collision', () => {
  it('allows two different merchants to use the exact same Idempotency-Key UUID independently without collision', async () => {
    const sharedIdempotencyKey = `idem-shared-${Date.now()}`;

    // Both merchants use the same idempotency key but have different merchantIds
    // The composite primary key (merchant_id, operation, key) ensures they don't collide
    const [res1, res2] = await Promise.all([
      PaymentApplicationService.initiatePayment({
        merchantId: 'merchant_demo_1',
        merchantOrderId: `ord_m1_${Date.now()}`,
        paymentMethod: 'CARD',
        currency: 'INR',
        amountMinor: '10000',
        captureMode: 'AUTOMATIC',
        idempotencyKey: sharedIdempotencyKey
      }),
      PaymentApplicationService.initiatePayment({
        merchantId: 'merchant_demo_2',
        merchantOrderId: `ord_m2_${Date.now()}`,
        paymentMethod: 'CARD',
        currency: 'INR',
        amountMinor: '20000',
        captureMode: 'AUTOMATIC',
        idempotencyKey: sharedIdempotencyKey
      })
    ]);

    // Both must succeed
    expect(res1.statusCode).toBe(201);
    expect(res2.statusCode).toBe(201);

    // Must be completely distinct transactions
    expect(res1.body.id).not.toBe(res2.body.id);
    expect(res1.body.amount_minor).toBe('10000');
    expect(res2.body.amount_minor).toBe('20000');

    // Verify composite primary key in database: exactly 2 rows, one per merchant
    const pool = getPool();
    const idemRes = await pool.query(
      `SELECT merchant_id, key FROM idempotency_keys WHERE key = $1 ORDER BY merchant_id ASC`,
      [sharedIdempotencyKey]
    );

    expect(idemRes.rows.length).toBe(2);
    const merchantIds = idemRes.rows.map((r: any) => r.merchant_id);
    expect(merchantIds).toContain('merchant_demo_1');
    expect(merchantIds).toContain('merchant_demo_2');
  });
});
