import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../../src/app.js';
import { PaymentApplicationService } from '../../../src/modules/payments/payment.service.js';
import { TransactionRepository } from '../../../src/database/repositories/transaction.repository.js';
import { MockGatewayController } from '../../../src/gateways/mocks/index.js';
import { withTransaction, getPool } from '../../../src/database/connection.js';
import { config } from '../../../src/shared/config/index.js';
import { v4 as uuidv4 } from 'uuid';

describe('FS-08: Refund on Already-Settled Payment', () => {
  const app = createApp();

  beforeEach(() => {
    MockGatewayController.reset();
  });

  it('successfully processes full refund on a payment in SETTLED state without balance corruption', async () => {
    // 1. Create a captured payment
    const orderId = `ord_fs08_${Date.now()}`;
    const paymentRes = await PaymentApplicationService.initiatePayment({
      merchantId: 'merchant_demo_1',
      merchantOrderId: orderId,
      paymentMethod: 'CARD',
      currency: 'INR',
      amountMinor: '100000',
      captureMode: 'AUTOMATIC',
      idempotencyKey: uuidv4()
    });

    const paymentId = paymentRes.body.id;

    // 2. Advance state to SETTLED (via settlement confirmation)
    await withTransaction(async (client) => {
      await TransactionRepository.transitionState(client, {
        transactionId: paymentId,
        toState: 'SETTLED',
        event: 'SETTLEMENT_CONFIRMED',
        traceId: uuidv4(),
        createdBy: 'settlement_job'
      });
    });

    const settledTx = await PaymentApplicationService.getPaymentById(paymentId, 'merchant_demo_1');
    expect(settledTx.state).toBe('SETTLED');

    // 3. Initiate refund on the settled payment
    const refundRes = await request(app)
      .post(`/api/v1/payments/${paymentId}/refund`)
      .set('x-merchant-id', 'merchant_demo_1')
      .set('x-api-key', config.MERCHANT_API_KEY)
      .set('idempotency-key', uuidv4())
      .send({
        amount_minor: '100000',
        reason: 'Customer return after batch settlement'
      });

    expect(refundRes.status).toBe(200);
    expect(refundRes.body.state).toBe('REFUNDED');


    // 4. Verify financial invariants
    const updated = await PaymentApplicationService.getPaymentById(paymentId, 'merchant_demo_1');
    expect(updated.state).toBe('REFUNDED');
    expect(updated.captured_minor).toBe('100000');
    expect(updated.refunded_minor).toBe('100000');

    // 5. Verify timeline includes SETTLED -> REFUND_INITIATED -> REFUNDED
    const pool = getPool();
    const logRes = await pool.query(
      `SELECT from_state, to_state, event FROM transaction_state_log WHERE transaction_id = $1 ORDER BY created_at ASC`,
      [paymentId]
    );

    const events = logRes.rows.map((r: any) => `${r.from_state}->${r.to_state}`);
    expect(events).toContain('CAPTURED->SETTLED');
    expect(events).toContain('SETTLED->REFUND_INITIATED');
    expect(events).toContain('REFUND_INITIATED->REFUNDED');
  });
});
