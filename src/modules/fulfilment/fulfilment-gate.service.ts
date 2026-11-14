import { PoolClient } from 'pg';
import { getPool } from '../../database/connection.js';
import { TransactionRepository } from '../../database/repositories/transaction.repository.js';
import { logger } from '../../shared/logging/logger.js';
import { UnprocessableEntityError } from '../../shared/errors/index.js';

export interface FulfilmentEvent {
  transactionId: string;
  merchantId: string;
  orderId: string;
  amountMinor: string;
  currency: string;
  status: 'FULFILMENT_ALLOWED';
  timestamp: string;
}

export class FulfilmentGateService {
  private static fulfilledTransactions: Set<string> = new Set();

  /**
   * Evaluates whether order fulfilment is permitted for a transaction.
   * GATING INVARIANT (C3, PDF p.37):
   * Fulfilment begins ONLY after CAPTURED or SETTLED.
   * Never during AUTH_INITIATED, AUTHORISED, or AUTH_EXPIRED.
   */
  static async canFulfil(transactionId: string, client?: PoolClient): Promise<{
    allowed: boolean;
    state: string;
    reason: string;
  }> {
    const dbClient = client || getPool();
    const tx = await TransactionRepository.findById(dbClient, transactionId);

    if (!tx) {
      return { allowed: false, state: 'NOT_FOUND', reason: 'Transaction does not exist' };
    }

    if (tx.state === 'CAPTURED' || tx.state === 'SETTLED') {
      return {
        allowed: true,
        state: tx.state,
        reason: 'Payment confirmed captured. Fulfilment unlocked.'
      };
    }

    return {
      allowed: false,
      state: tx.state,
      reason: `Cannot fulfil order in payment state ${tx.state}. Fulfilment requires CAPTURED or SETTLED.`
    };
  }

  /**
   * Emits a fulfilment notification event if and only if the transaction is confirmed CAPTURED or SETTLED.
   * Idempotent: repeated calls for the same transaction will not dispatch duplicate events.
   */
  static async triggerFulfilment(transactionId: string, client?: PoolClient): Promise<FulfilmentEvent | null> {
    const gateCheck = await this.canFulfil(transactionId, client);
    if (!gateCheck.allowed) {
      logger.warn({
        action: 'fulfilment_gate_blocked',
        transaction_id: transactionId,
        state: gateCheck.state,
        reason: gateCheck.reason,
        message: 'Order fulfilment blocked: payment is not in CAPTURED state'
      });
      throw new UnprocessableEntityError(gateCheck.reason, 'FULFILMENT_NOT_PERMITTED');
    }

    if (this.fulfilledTransactions.has(transactionId)) {
      logger.info({
        action: 'fulfilment_duplicate_ignored',
        transaction_id: transactionId,
        message: 'Order fulfilment already dispatched for this transaction'
      });
      return null;
    }

    const dbClient = client || getPool();
    const tx = (await TransactionRepository.findById(dbClient, transactionId))!;

    this.fulfilledTransactions.add(transactionId);

    const event: FulfilmentEvent = {
      transactionId: tx.id,
      merchantId: tx.merchant_id,
      orderId: tx.merchant_order_id,
      amountMinor: tx.amount_minor,
      currency: tx.currency,
      status: 'FULFILMENT_ALLOWED',
      timestamp: new Date().toISOString()
    };

    logger.info({
      action: 'fulfilment_event_dispatched',
      event: 'fulfilment.allowed',
      transaction_id: tx.id,
      merchant_order_id: tx.merchant_order_id,
      amount_minor: tx.amount_minor,
      currency: tx.currency,
      message: 'Payment verified CAPTURED: order fulfilment permitted and event dispatched'
    });

    return event;
  }

  static resetForTesting(): void {
    this.fulfilledTransactions.clear();
  }
}

