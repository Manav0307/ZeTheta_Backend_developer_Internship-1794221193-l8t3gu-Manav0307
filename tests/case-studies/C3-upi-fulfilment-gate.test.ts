import { describe, it, expect, beforeEach, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { getPool, withTransaction } from '../../src/database/connection.js';
import { PaymentApplicationService } from '../../src/modules/payments/payment.service.js';
import { FulfilmentGateService } from '../../src/modules/fulfilment/fulfilment-gate.service.js';
import { TransactionRepository } from '../../src/database/repositories/transaction.repository.js';
import { logger } from '../../src/shared/logging/logger.js';

describe('C3: UPI Mandate Exploitation Prevention & Fulfilment Gate', () => {
  const app = createApp();
  const pool = getPool();

  beforeEach(() => {
    FulfilmentGateService.resetForTesting();
  });

  it('1. Strict Fulfilment Gating: Order fulfilment is BLOCKED during AUTH_INITIATED', async () => {
    const orderId = `ord_c3_pending_${Date.now()}`;
    const traceId = uuidv4();
    let txId = '';

    // Create a transaction in AUTH_INITIATED state (pending user approval in UPI app)
    await withTransaction(async (client) => {
      const tx = await TransactionRepository.create(client, {
        merchant_id: 'merchant_demo_1',
        merchant_order_id: orderId,
        payment_method: 'UPI',
        currency: 'INR',
        amount_minor: '19900',
        capture_mode: 'AUTOMATIC',
        trace_id: traceId
      });
      txId = tx.id;

      await TransactionRepository.transitionState(client, {
        transactionId: tx.id,
        toState: 'ROUTE_SELECTED',
        event: 'ROUTE_SELECT',
        traceId,
        createdBy: 'router'
      });

      await TransactionRepository.transitionState(client, {
        transactionId: tx.id,
        toState: 'AUTH_INITIATED',
        event: 'BEGIN_AUTH',
        traceId,
        createdBy: 'upi_service'
      });
    });

    // Check fulfilment gate
    const gateCheck = await FulfilmentGateService.canFulfil(txId);
    expect(gateCheck.allowed).toBe(false);
    expect(gateCheck.state).toBe('AUTH_INITIATED');
    expect(gateCheck.reason).toContain('Fulfilment requires CAPTURED or SETTLED');

    // Attempting to trigger fulfilment MUST throw FULFILMENT_NOT_PERMITTED
    await expect(FulfilmentGateService.triggerFulfilment(txId)).rejects.toThrow(
      /Fulfilment requires CAPTURED or SETTLED/i
    );
  });

  it('2. Mandate Expiry: Expired UPI collect mandate permits ZERO fulfilment events and 0 retries', async () => {
    const loggerInfoSpy = vi.spyOn(logger, 'info');
    const orderId = `ord_c3_expired_${Date.now()}`;
    const traceId = uuidv4();
    let txId = '';

    // Create a UPI payment in AUTH_INITIATED state
    await withTransaction(async (client) => {
      const tx = await TransactionRepository.create(client, {
        merchant_id: 'merchant_demo_1',
        merchant_order_id: orderId,
        payment_method: 'UPI',
        currency: 'INR',
        amount_minor: '49900',
        capture_mode: 'AUTOMATIC',
        trace_id: traceId
      });
      txId = tx.id;

      await TransactionRepository.transitionState(client, {
        transactionId: tx.id,
        toState: 'ROUTE_SELECTED',
        event: 'ROUTE_SELECT',
        traceId,
        createdBy: 'router'
      });

      await TransactionRepository.transitionState(client, {
        transactionId: tx.id,
        toState: 'AUTH_INITIATED',
        event: 'BEGIN_AUTH',
        traceId,
        createdBy: 'upi_service'
      });
    });

    // Customer does not approve in app: mandate window expires (5 min)
    const expireRes = await request(app)
      .post(`/api/v1/payments/${txId}/expire`)
      .set('x-merchant-id', 'merchant_demo_1')
      .set('x-api-key', 'key_test_merchant_demo_1')
      .send();

    expect(expireRes.status).toBe(200);
    expect(expireRes.body.state).toBe('AUTH_EXPIRED');
    expect(expireRes.body.customer_notified).toBe(true);

    // Verify fulfilment gate strictly blocks expired payments
    const gateCheck = await FulfilmentGateService.canFulfil(txId);
    expect(gateCheck.allowed).toBe(false);
    expect(gateCheck.state).toBe('AUTH_EXPIRED');

    await expect(FulfilmentGateService.triggerFulfilment(txId)).rejects.toThrow(
      /Cannot fulfil order in payment state AUTH_EXPIRED/i
    );

    // Verify 0 retries were attempted for expired collect
    const attempts = await pool.query(
      `SELECT * FROM payment_attempts WHERE transaction_id = $1`,
      [txId]
    );
    expect(attempts.rows.length).toBeLessThanOrEqual(1);

    loggerInfoSpy.mockRestore();
  });

  it('3. Successful Capture Unlocks Fulfilment: Exactly 1 fulfilment event emitted even on duplicate triggers', async () => {
    // Create and auto-capture payment
    const orderId = `ord_c3_captured_${Date.now()}`;
    const payment = await PaymentApplicationService.initiatePayment({
      merchantId: 'merchant_demo_1',
      merchantOrderId: orderId,
      paymentMethod: 'UPI',
      currency: 'INR',
      amountMinor: '75000',
      captureMode: 'AUTOMATIC',
      idempotencyKey: uuidv4()
    });

    const txId = payment.body.id;

    // Verify gate check allows fulfilment
    const gateCheck = await FulfilmentGateService.canFulfil(txId);
    expect(gateCheck.allowed).toBe(true);
    expect(gateCheck.state).toBe('CAPTURED');

    // Trigger first fulfilment
    const event1 = await FulfilmentGateService.triggerFulfilment(txId);
    expect(event1).not.toBeNull();
    expect(event1?.status).toBe('FULFILMENT_ALLOWED');
    expect(event1?.orderId).toBe(orderId);
    expect(event1?.amountMinor).toBe('75000');

    // Trigger duplicate fulfilment call: must be idempotent and return null (0 duplicate events)
    const event2 = await FulfilmentGateService.triggerFulfilment(txId);
    expect(event2).toBeNull();
  });
});
