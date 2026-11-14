import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { createApp } from '../../src/app.js';
import { getPool } from '../../src/database/connection.js';
import { PaymentApplicationService } from '../../src/modules/payments/payment.service.js';
import { ReconciliationService } from '../../src/modules/reconciliation/reconciliation.service.js';
import { WebhookService } from '../../src/modules/webhooks/webhook.service.js';
import { TransactionRepository } from '../../src/database/repositories/transaction.repository.js';
import { MockGatewayController } from '../../src/gateways/mocks/index.js';
import { config } from '../../src/shared/config/index.js';
import crypto from 'crypto';

describe('C2: Silent Settlement Leak Prevention & Reconciliation Engine', () => {
  const app = createApp();
  const pool = getPool();

  beforeEach(async () => {
    MockGatewayController.reset();
    await pool.query(`DELETE FROM webhook_queue`);
    await pool.query(`DELETE FROM processed_webhook_events`);
  });

  it('1. Settlement Discrepancy Detection: flags missing settlement anomalies without issuing automatic refunds (FS-11 / C2)', async () => {
    // Seed 5 internally CAPTURED transactions
    const txIds: string[] = [];
    const providerRefs: string[] = [];

    for (let i = 0; i < 5; i++) {
      const payment = await PaymentApplicationService.initiatePayment({
        merchantId: 'merchant_demo_1',
        merchantOrderId: `ord_c2_missing_${i}_${Date.now()}`,
        paymentMethod: 'CARD',
        currency: 'INR',
        amountMinor: '25000',
        captureMode: 'AUTOMATIC',
        idempotencyKey: uuidv4()
      });
      txIds.push(payment.body.id);
      providerRefs.push(payment.body.provider_payment_ref);
    }

    // Run settlement reconciliation against an EMPTY settlement report (all 5 missing)
    const result = await ReconciliationService.reconcileSettlementBatch({
      settlementFileRecords: [],
      transactionIds: txIds,
      triggerSource: 'MANUAL'
    });

    expect(result.status).toBe('COMPLETED');
    expect(result.mismatchCount).toBe(5);

    // Verify exactly 5 anomaly records were persisted
    const anomalyRes = await pool.query(
      `SELECT * FROM reconciliation_anomalies WHERE transaction_id = ANY($1::uuid[])`,
      [txIds]
    );
    expect(anomalyRes.rows.length).toBe(5);

    // CRITICAL C2 INVARIANT: Assert ZERO automatic refunds were initiated
    const refundRes = await pool.query(
      `SELECT * FROM refunds WHERE transaction_id = ANY($1::uuid[])`,
      [txIds]
    );
    expect(refundRes.rows.length).toBe(0);

    // Verify transaction state remains CAPTURED (never illegally mutated to FAILED)
    for (const txId of txIds) {
      const tx = await TransactionRepository.findById(pool, txId);
      expect(tx?.state).toBe('CAPTURED');
      expect(tx?.settlement_status).toBe('DISCREPANCY');
    }
  });

  it('2. Confirmed Settlement Batch Inclusion: correctly transitions CAPTURED to SETTLED with batch tracking', async () => {
    const payment = await PaymentApplicationService.initiatePayment({
      merchantId: 'merchant_demo_1',
      merchantOrderId: `ord_c2_settled_${Date.now()}`,
      paymentMethod: 'CARD',
      currency: 'INR',
      amountMinor: '50000',
      captureMode: 'AUTOMATIC',
      idempotencyKey: uuidv4()
    });

    const txId = payment.body.id;
    const providerRef = payment.body.provider_payment_ref;

    // Gateway settlement batch confirms settlement
    const result = await ReconciliationService.reconcileSettlementBatch({
      settlementFileRecords: [
        {
          providerReference: providerRef,
          amountMinor: '50000',
          gateway: payment.body.selected_gateway
        }
      ],
      transactionIds: [txId],
      triggerSource: 'MANUAL'
    });

    expect(result.status).toBe('COMPLETED');
    expect(result.mismatchCount).toBe(0);

    const tx = await TransactionRepository.findById(pool, txId);
    expect(tx?.state).toBe('SETTLED');
    expect(tx?.settlement_status).toBe('SETTLED');
  });

  it('3. Dispute Webhook Ingestion: dispute.created webhook flags anomaly without illegal state change or auto-refund', async () => {
    MockGatewayController.setBehavior('payu', 'definite_5xx');
    MockGatewayController.setBehavior('razorpay', 'success');
    MockGatewayController.setBehavior('stripe', 'definite_5xx');

    const payment = await PaymentApplicationService.initiatePayment({
      merchantId: 'merchant_demo_1',
      merchantOrderId: `ord_c2_dispute_${Date.now()}`,
      paymentMethod: 'CARD',
      currency: 'INR',
      amountMinor: '35000',
      captureMode: 'AUTOMATIC',
      idempotencyKey: uuidv4()
    });

    expect(payment.body.selected_gateway).toBe('razorpay');
    const txId = payment.body.id;
    const providerRef = payment.body.provider_payment_ref;

    // Ingest simulated dispute webhook
    const eventId = `evt_disp_${Date.now()}`;
    const disputePayload = {
      id: eventId,
      entity: 'event',
      event: 'dispute.created',
      payload: {
        payment: {
          entity: {
            id: providerRef,
            amount: 35000,
            currency: 'INR',
            status: 'disputed'
          }
        }
      }
    };

    const rawBody = Buffer.from(JSON.stringify(disputePayload));
    const signature = crypto.createHmac('sha256', config.RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest('hex');

    await WebhookService.ingestWebhook('razorpay', rawBody, {
      'x-razorpay-signature': signature,
      'x-razorpay-event-id': eventId
    });

    // Process webhook queue
    await WebhookService.processNextQueueItem();

    // Verify dispute anomaly record created in DB
    const anomaly = await pool.query(
      `SELECT * FROM reconciliation_anomalies WHERE transaction_id = $1 AND anomaly_type = 'WEBHOOK_DISPUTE_RAISED'`,
      [txId]
    );
    expect(anomaly.rows.length).toBe(1);
    expect(anomaly.rows[0].severity).toBe('HIGH');
    expect(anomaly.rows[0].status).toBe('OPEN');

    // Verify zero unauthorized auto-refunds
    const refunds = await pool.query(`SELECT * FROM refunds WHERE transaction_id = $1`, [txId]);
    expect(refunds.rows.length).toBe(0);
  });
});
