import { describe, it, expect, beforeEach } from 'vitest';
import { ReconciliationService } from '../../src/modules/reconciliation/reconciliation.service.js';
import { PaymentApplicationService } from '../../src/modules/payments/payment.service.js';
import { MockGatewayController } from '../../src/gateways/mocks/index.js';
import { getPool } from '../../src/database/connection.js';
import { v4 as uuidv4 } from 'uuid';

describe('Reconciliation Engine Integration Tests', () => {
  beforeEach(() => {
    MockGatewayController.reset();
  });

  it('detects stale AUTH_INITIATED transaction, polls status, and updates state with RECONCILIATION_OVERRIDE', async () => {
    const pool = getPool();
    const orderId = `ord_rec_stale_${Date.now()}`;
    const traceId = uuidv4();

    // Insert a stale payment stuck in AUTH_INITIATED created 10 minutes ago
    const txRes = await pool.query(
      `
      INSERT INTO transactions (
        merchant_id, merchant_order_id, payment_method, currency, amount_minor,
        state, trace_id, created_at
      ) VALUES ('merchant_demo_1', $1, 'CARD', 'INR', 40000, 'AUTH_INITIATED', $2, NOW() - INTERVAL '10 minutes')
      RETURNING id
    `,
      [orderId, traceId]
    );
    const txId = txRes.rows[0].id;
    const providerRef = `pay_rzp_rec_${Date.now()}`;

    await pool.query(
      `
      INSERT INTO payment_attempts (
        transaction_id, gateway, attempt_no, amount_minor, trace_id,
        status, provider_payment_ref
      ) VALUES ($1, 'razorpay', 1, 40000, $2, 'SENT', $3)
    `,
      [txId, traceId, providerRef]
    );

    // Mock provider says it actually succeeded as AUTHORISED
    MockGatewayController.recordCharge(providerRef, 'AUTHORISED', '40000', 'razorpay');

    // Run reconciliation (looking for items older than 5 minutes)
    const run = await ReconciliationService.triggerRun('MANUAL', 5);
    expect(run.status).toBe('COMPLETED');
    expect(run.mismatchCount).toBeGreaterThanOrEqual(1);

    // Assert transaction state was corrected to AUTHORISED
    const updated = await PaymentApplicationService.getPaymentById(txId);
    expect(updated.state).toBe('AUTHORISED');

    // Assert audit event is RECONCILIATION_OVERRIDE
    const timeline = await PaymentApplicationService.getTimeline(txId);
    const overrideEntry = timeline.find((t) => t.event === 'RECONCILIATION_OVERRIDE');
    expect(overrideEntry).toBeDefined();
    expect(overrideEntry?.created_by).toBe('reconciliation_engine');
  });

  it('detects critical anomaly (internal CAPTURED vs provider FAILED) without erasing funds', async () => {
    const pool = getPool();
    const orderId = `ord_rec_anomaly_${Date.now()}`;
    const traceId = uuidv4();
    const providerRef = `pay_rzp_anom_${Date.now()}`;

    // Payment marked CAPTURED internally, but stuck in review
    const txRes = await pool.query(
      `
      INSERT INTO transactions (
        merchant_id, merchant_order_id, payment_method, currency, amount_minor,
        authorized_minor, captured_minor, state, trace_id, created_at
      ) VALUES ('merchant_demo_1', $1, 'CARD', 'INR', 50000, 50000, 50000, 'CAPTURE_INITIATED', $2, NOW() - INTERVAL '10 minutes')
      RETURNING id
    `,
      [orderId, traceId]
    );
    const txId = txRes.rows[0].id;

    await pool.query(
      `
      INSERT INTO payment_attempts (
        transaction_id, gateway, attempt_no, amount_minor, trace_id,
        status, provider_payment_ref
      ) VALUES ($1, 'razorpay', 1, 50000, $2, 'SENT', $3)
    `,
      [txId, traceId, providerRef]
    );

    // Mark internal state as CAPTURED to simulate discrepancy
    await pool.query(`UPDATE transactions SET state = 'CAPTURED' WHERE id = $1`, [txId]);

    // Provider says FAILED!
    MockGatewayController.recordCharge(providerRef, 'FAILED', '50000', 'razorpay');

    const run = await ReconciliationService.triggerRun('MANUAL', 5);
    const report = await ReconciliationService.getReport(run.runId);

    // Assert anomaly was raised
    const anomaly = report.anomalies.find((a: any) => a.transaction_id === txId);
    expect(anomaly).toBeDefined();
    expect(anomaly.severity).toBe('CRITICAL');

    // CRITICAL: Internal state must NOT be silently overwritten to FAILED!
    const finalTx = await PaymentApplicationService.getPaymentById(txId);
    expect(finalTx.state).toBe('CAPTURED');
  });
});

