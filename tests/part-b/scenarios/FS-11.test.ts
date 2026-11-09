import { describe, it, expect, beforeEach } from 'vitest';
import { PaymentApplicationService } from '../../../src/modules/payments/payment.service.js';
import { ReconciliationService } from '../../../src/modules/reconciliation/reconciliation.service.js';
import { getPool } from '../../../src/database/connection.js';
import { v4 as uuidv4 } from 'uuid';

describe('FS-11: Missing Settlements in Batch Reconciliation', () => {
  beforeEach(() => {
    // reset
  });

  it('detects 5 missing settlement records, logs RECONCILIATION_MISMATCH anomalies, blocks auto-refund, preserves financial ledger', async () => {
    const paymentIds: string[] = [];
    const providerRefs: string[] = [];

    // 1. Create 5 captured payments
    for (let i = 1; i <= 5; i++) {
      const orderId = `ord_fs11_${i}_${Date.now()}`;
      const res = await PaymentApplicationService.initiatePayment({
        merchantId: 'merchant_demo_1',
        merchantOrderId: orderId,
        paymentMethod: 'CARD',
        currency: 'INR',
        amountMinor: '100000',
        captureMode: 'AUTOMATIC',
        idempotencyKey: uuidv4()
      });
      paymentIds.push(res.body.id);
      providerRefs.push(res.body.provider_payment_ref);
    }

    // 2. Mock settlement batch has NO records for these 5 payments (missing settlements file)
    const emptySettlementBatch: any[] = [];

    // 3. Run settlement reconciliation on these 5 transactions
    const recResult = await ReconciliationService.reconcileSettlementBatch({
      settlementFileRecords: emptySettlementBatch,
      transactionIds: paymentIds
    });

    expect(recResult.status).toBe('COMPLETED');
    expect(recResult.scannedCount).toBe(5);
    expect(recResult.mismatchCount).toBe(5);
    expect(recResult.anomalies.length).toBe(5);

    // 4. Verify financial ledger is PRESERVED: transactions remain CAPTURED with 0 refunded
    for (const id of paymentIds) {
      const tx = await PaymentApplicationService.getPaymentById(id, 'merchant_demo_1');
      expect(tx.state).toBe('CAPTURED');
      expect(tx.captured_minor).toBe('100000');
      expect(tx.refunded_minor).toBe('0'); // Invariant: NO auto-refund on settlement discrepancy!
    }

    // 5. Verify audit log contains SETTLEMENT_INVESTIGATION_LOGGED
    const pool = getPool();
    for (const id of paymentIds) {
      const logRes = await pool.query(
        `SELECT * FROM transaction_state_log WHERE transaction_id = $1 AND event = 'SETTLEMENT_INVESTIGATION_LOGGED'`,
        [id]
      );
      expect(logRes.rows.length).toBe(1);
      expect(logRes.rows[0].metadata.anomaly_type).toBe('MISSING_SETTLEMENT');
      expect(logRes.rows[0].metadata.auto_refund_blocked).toBe(true);
    }
  });
});

