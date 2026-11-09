import { v4 as uuidv4 } from 'uuid';
import { withTransaction, getPool } from '../../database/connection.js';
import { TransactionRepository } from '../../database/repositories/transaction.repository.js';
import { PaymentAttemptRepository } from '../../database/repositories/attempt.repository.js';
import { CaptureRepository } from '../../database/repositories/capture.repository.js';
import { RefundRepository } from '../../database/repositories/refund.repository.js';
import { CircuitBreakerRepository } from '../../database/repositories/circuit-breaker.repository.js';
import { MetricsRepository } from '../../database/repositories/metrics.repository.js';
import { IntelligentRouter } from '../routing/index.js';
import { OutboundRateLimiter } from '../rate-limiter/index.js';
import { GatewayRegistry } from '../../gateways/registry.js';
import { IdempotencyManager } from '../idempotency/index.js';
import { PaymentMethod, CaptureMode, TransactionRecord, TransactionState } from '../../shared/types/index.js';
import {
  BadRequestError,
  NotFoundError,
  ConflictError,
  UnprocessableEntityError,
  TooManyRequestsError,
  AppError,
  InvalidStateTransitionException
} from '../../shared/errors/index.js';

import { logger } from '../../shared/logging/logger.js';

export class PaymentApplicationService {
  static async initiatePayment(params: {
    merchantId: string;
    merchantOrderId: string;
    paymentMethod: PaymentMethod;
    currency: string;
    amountMinor: string;
    captureMode?: CaptureMode;
    idempotencyKey: string;
    traceId?: string;
    metadata?: Record<string, any>;
  }): Promise<{ statusCode: number; body: any }> {
    const traceId = params.traceId || uuidv4();
    const captureMode = params.captureMode || 'MANUAL';
    const amount = BigInt(params.amountMinor);

    if (amount <= 0n) {
      throw new BadRequestError('Payment amount must be greater than zero', 'INVALID_AMOUNT');
    }

    // 1. Idempotency Check & Transaction Creation
    let transaction!: TransactionRecord;
    let isCached = false;
    let cachedResult: any = null;

    await withTransaction(async (client) => {
      // Check existing merchant order uniqueness
      const existingTx = await TransactionRepository.findByMerchantOrderId(
        client,
        params.merchantId,
        params.merchantOrderId
      );

      const idempotencyPayload = {
        merchant_id: params.merchantId,
        merchant_order_id: params.merchantOrderId,
        amount_minor: params.amountMinor,
        currency: params.currency,
        payment_method: params.paymentMethod,
        capture_mode: captureMode,
        metadata: params.metadata || {}
      };

      const claim = await IdempotencyManager.claimKey(
        client,
        params.merchantId,
        'PAYMENT_CREATE',
        params.idempotencyKey,
        idempotencyPayload,
        existingTx?.id
      );

      if (claim.isCached) {
        isCached = true;
        cachedResult = { statusCode: claim.statusCode || 200, body: claim.responseBody };
        return;
      }

      if (existingTx) {
        transaction = existingTx;
      } else {
        transaction = await TransactionRepository.create(client, {
          merchant_id: params.merchantId,
          merchant_order_id: params.merchantOrderId,
          payment_method: params.paymentMethod,
          currency: params.currency,
          amount_minor: params.amountMinor,
          capture_mode: captureMode,
          trace_id: traceId,
          metadata: params.metadata,
          created_by: 'merchant_api'
        });
      }
    });

    if (isCached) {
      return cachedResult;
    }

    // 2. Select route & prepare attempt in short DB transaction
    let selectedGateway = '';
    let attemptId = '';
    let attemptNo = 1;

    await withTransaction(async (client) => {
      const routingResult = await IntelligentRouter.selectRoute(client, {
        transactionId: transaction.id,
        paymentMethod: params.paymentMethod,
        currency: params.currency,
        amountMinor: params.amountMinor,
        traceId
      });

      selectedGateway = routingResult.selectedGateway;

      await TransactionRepository.transitionState(client, {
        transactionId: transaction.id,
        toState: 'ROUTE_SELECTED',
        event: 'ROUTE_SELECT',
        traceId,
        createdBy: 'router',
        metadata: { selectedGateway }
      });

      await TransactionRepository.transitionState(client, {
        transactionId: transaction.id,
        toState: 'AUTH_INITIATED',
        event: 'BEGIN_AUTH',
        traceId,
        createdBy: 'payment_service',
        metadata: { gateway: selectedGateway }
      });

      attemptNo = await PaymentAttemptRepository.getNextAttemptNumber(client, transaction.id);
      const attempt = await PaymentAttemptRepository.createAttempt(client, {
        transaction_id: transaction.id,
        gateway: selectedGateway,
        attempt_no: attemptNo,
        amount_minor: params.amountMinor,
        trace_id: traceId,
        provider_idempotency_key: `idem_${transaction.id}_${attemptNo}`
      });

      attemptId = attempt.id;
    });

    // 3. Dispatch to Gateway outside DB transaction
    const adapter = GatewayRegistry.get(selectedGateway);
    const rateCheck = OutboundRateLimiter.checkLimit(selectedGateway);
    if (!rateCheck.allowed) {
      throw new TooManyRequestsError(
        `Outbound rate limit exceeded for gateway ${selectedGateway}`,
        'GATEWAY_RATE_LIMITED'
      );
    }
    OutboundRateLimiter.consume(selectedGateway);

    const startTime = Date.now();
    const outcome = await adapter.authorize({
      transactionId: transaction.id,
      attemptId,
      amountMinor: params.amountMinor,
      currency: params.currency,
      paymentMethod: params.paymentMethod,
      captureMode,
      traceId,
      idempotencyKey: params.idempotencyKey,
      metadata: params.metadata
    });
    const durationMs = Date.now() - startTime;

    logger.info({
      trace_id: traceId,
      transaction_id: transaction.id,
      component: 'payment_service',
      action: 'gateway_auth_dispatched',
      gateway: selectedGateway,
      duration_ms: durationMs,
      status: outcome.status,
      message: `Gateway ${selectedGateway} returned status ${outcome.status}`
    });

    // 4. Handle Gateway Outcome
    if (outcome.status === 'AUTHORISED' || outcome.status === 'CAPTURED') {
      const isCaptured = outcome.status === 'CAPTURED';
      const toState = isCaptured ? 'CAPTURED' : 'AUTHORISED';

      let finalTx: TransactionRecord;
      await withTransaction(async (client) => {
        await PaymentAttemptRepository.updateStatus(client, {
          attempt_id: attemptId,
          status: isCaptured ? 'CAPTURED' : 'AUTHORISED',
          provider_payment_ref: outcome.providerPaymentRef,
          provider_order_ref: outcome.providerOrderRef
        });

        finalTx = await TransactionRepository.transitionState(client, {
          transactionId: transaction.id,
          toState,
          event: isCaptured ? 'CAPTURE_COMPLETE' : 'AUTH_SUCCESS',
          traceId,
          createdBy: 'gateway_response',
          attemptId,
          gatewayReference: outcome.providerPaymentRef,
          gatewayResponse: outcome.rawResponse,
          authorized_minor: params.amountMinor,
          captured_minor: isCaptured ? params.amountMinor : '0'
        });

        await CircuitBreakerRepository.recordSuccess(client, selectedGateway, params.paymentMethod);
        await MetricsRepository.recordAttemptOutcome(
          client,
          selectedGateway,
          params.paymentMethod,
          durationMs,
          true
        );

        const responsePayload = {
          id: finalTx.id,
          merchant_order_id: finalTx.merchant_order_id,
          amount_minor: finalTx.amount_minor,
          currency: finalTx.currency,
          state: finalTx.state,
          selected_gateway: selectedGateway,
          provider_payment_ref: outcome.providerPaymentRef,
          trace_id: traceId,
          created_at: finalTx.created_at
        };

        await IdempotencyManager.completeKey(
          client,
          params.merchantId,
          'PAYMENT_CREATE',
          params.idempotencyKey,
          201,
          responsePayload,
          finalTx.id
        );
      });

      return {
        statusCode: 201,
        body: {
          id: transaction.id,
          merchant_order_id: params.merchantOrderId,
          amount_minor: params.amountMinor,
          currency: params.currency,
          state: toState,
          selected_gateway: selectedGateway,
          provider_payment_ref: outcome.providerPaymentRef,
          trace_id: traceId,
          created_at: new Date().toISOString()
        }
      };
    }

    if (outcome.status === 'HARD_DECLINE') {
      await withTransaction(async (client) => {
        await PaymentAttemptRepository.updateStatus(client, {
          attempt_id: attemptId,
          status: 'FAILED',
          error_class: 'HARD_DECLINE',
          error_code: outcome.errorCode
        });

        await TransactionRepository.transitionState(client, {
          transactionId: transaction.id,
          toState: 'AUTH_FAILED',
          event: 'AUTH_DECLINE',
          traceId,
          createdBy: 'gateway_response',
          attemptId,
          gatewayResponse: outcome.rawResponse,
          lastErrorCode: outcome.errorCode
        });

        await TransactionRepository.transitionState(client, {
          transactionId: transaction.id,
          toState: 'FAILED',
          event: 'TERMINAL_FAIL',
          traceId,
          createdBy: 'payment_service',
          attemptId,
          lastErrorCode: outcome.errorCode
        });

        const errorBody = {
          error: {
            code: 'PAYMENT_AUTH_FAILED',
            message: outcome.errorMessage || 'Payment authorisation was declined by the issuing bank.',
            details: {
              gateway: selectedGateway,
              gateway_error_code: outcome.errorCode || 'DECLINED',
              suggestion: 'Please try a different payment method or contact your bank.'
            },
            request_id: traceId,
            timestamp: new Date().toISOString()
          }
        };

        await IdempotencyManager.failKey(
          client,
          params.merchantId,
          'PAYMENT_CREATE',
          params.idempotencyKey,
          422,
          errorBody
        );
      });

      throw new UnprocessableEntityError(
        outcome.errorMessage || 'Payment authorisation was declined by the issuing bank.',
        'PAYMENT_AUTH_FAILED',
        {
          gateway: selectedGateway,
          gateway_error_code: outcome.errorCode || 'DECLINED',
          suggestion: 'Please try a different payment method or contact your bank.'
        }
      );
    }

    if (outcome.status === 'TIMEOUT_UNKNOWN') {
      await withTransaction(async (client) => {
        await PaymentAttemptRepository.updateStatus(client, {
          attempt_id: attemptId,
          status: 'UNKNOWN',
          error_class: 'TIMEOUT_UNKNOWN',
          error_code: outcome.errorCode,
          provider_payment_ref: outcome.providerPaymentRef
        });

        await TransactionRepository.transitionState(client, {
          transactionId: transaction.id,
          toState: 'AUTH_TIMEOUT',
          event: 'AUTH_TIMEOUT',
          traceId,
          createdBy: 'gateway_response',
          attemptId,
          lastErrorCode: outcome.errorCode
        });

        const uncertainBody = {
          id: transaction.id,
          merchant_order_id: params.merchantOrderId,
          amount_minor: params.amountMinor,
          currency: params.currency,
          state: 'AUTH_TIMEOUT',
          selected_gateway: selectedGateway,
          provider_payment_ref: outcome.providerPaymentRef,
          message: 'Payment status is currently uncertain. Polling/reconciliation in progress.',
          trace_id: traceId
        };

        await IdempotencyManager.markUnknown(
          client,
          params.merchantId,
          'PAYMENT_CREATE',
          params.idempotencyKey,
          202,
          uncertainBody
        );
      });

      return {
        statusCode: 202,
        body: {
          id: transaction.id,
          merchant_order_id: params.merchantOrderId,
          amount_minor: params.amountMinor,
          currency: params.currency,
          state: 'AUTH_TIMEOUT',
          selected_gateway: selectedGateway,
          provider_payment_ref: outcome.providerPaymentRef,
          message: 'Payment status is uncertain; reconciliation scheduled.',
          trace_id: traceId
        }
      };
    }

    // 5. Transient failure -> Safe Failover to alternate gateway
    let failoverSuccess = false;
    let failoverResult: any = null;

    await withTransaction(async (client) => {
      await PaymentAttemptRepository.updateStatus(client, {
        attempt_id: attemptId,
        status: 'FAILED',
        error_class: 'TRANSIENT_FAILURE',
        error_code: outcome.errorCode
      });

      await TransactionRepository.transitionState(client, {
        transactionId: transaction.id,
        toState: 'AUTH_FAILED',
        event: 'AUTH_DECLINE',
        traceId,
        createdBy: 'gateway_response',
        attemptId,
        lastErrorCode: outcome.errorCode
      });

      await CircuitBreakerRepository.recordFailure(client, selectedGateway, params.paymentMethod);
      await MetricsRepository.recordAttemptOutcome(
        client,
        selectedGateway,
        params.paymentMethod,
        durationMs,
        false
      );
    });

    // Check if alternate healthy gateway is available for failover
    try {
      let alternateGateway = '';
      let secondAttemptId = '';

      await withTransaction(async (client) => {
        const reroute = await IntelligentRouter.selectRoute(client, {
          transactionId: transaction.id,
          paymentMethod: params.paymentMethod,
          currency: params.currency,
          amountMinor: params.amountMinor,
          traceId,
          excludeGateways: [selectedGateway]
        });

        if (reroute.selectedGateway) {
          alternateGateway = reroute.selectedGateway;

          await TransactionRepository.transitionState(client, {
            transactionId: transaction.id,
            toState: 'ROUTE_SELECTED',
            event: 'SAFE_REROUTE',
            traceId,
            createdBy: 'failover_router',
            metadata: { previousGateway: selectedGateway, failoverGateway: alternateGateway }
          });

          await TransactionRepository.transitionState(client, {
            transactionId: transaction.id,
            toState: 'AUTH_INITIATED',
            event: 'BEGIN_AUTH',
            traceId,
            createdBy: 'failover_service',
            metadata: { gateway: alternateGateway }
          });

          const secondAttemptNo = await PaymentAttemptRepository.getNextAttemptNumber(client, transaction.id);
          const secondAttempt = await PaymentAttemptRepository.createAttempt(client, {
            transaction_id: transaction.id,
            gateway: alternateGateway,
            attempt_no: secondAttemptNo,
            amount_minor: params.amountMinor,
            trace_id: traceId,
            provider_idempotency_key: `idem_${transaction.id}_${secondAttemptNo}`
          });

          secondAttemptId = secondAttempt.id;
        }
      });

      if (alternateGateway) {
        const altAdapter = GatewayRegistry.get(alternateGateway);
        const altOutcome = await altAdapter.authorize({
          transactionId: transaction.id,
          attemptId: secondAttemptId,
          amountMinor: params.amountMinor,
          currency: params.currency,
          paymentMethod: params.paymentMethod,
          captureMode,
          traceId,
          idempotencyKey: params.idempotencyKey,
          metadata: params.metadata
        });

        if (altOutcome.status === 'AUTHORISED' || altOutcome.status === 'CAPTURED') {
          const isCaptured = altOutcome.status === 'CAPTURED';
          const toState = isCaptured ? 'CAPTURED' : 'AUTHORISED';

          await withTransaction(async (client) => {
            await PaymentAttemptRepository.updateStatus(client, {
              attempt_id: secondAttemptId,
              status: isCaptured ? 'CAPTURED' : 'AUTHORISED',
              provider_payment_ref: altOutcome.providerPaymentRef,
              provider_order_ref: altOutcome.providerOrderRef
            });

            await TransactionRepository.transitionState(client, {
              transactionId: transaction.id,
              toState,
              event: isCaptured ? 'CAPTURE_COMPLETE' : 'AUTH_SUCCESS',
              traceId,
              createdBy: 'failover_success',
              attemptId: secondAttemptId,
              gatewayReference: altOutcome.providerPaymentRef,
              gatewayResponse: altOutcome.rawResponse,
              authorized_minor: params.amountMinor,
              captured_minor: isCaptured ? params.amountMinor : '0'
            });

            await CircuitBreakerRepository.recordSuccess(client, alternateGateway, params.paymentMethod);
            await MetricsRepository.recordAttemptOutcome(
              client,
              alternateGateway,
              params.paymentMethod,
              120,
              true
            );

            failoverResult = {
              id: transaction.id,
              merchant_order_id: params.merchantOrderId,
              amount_minor: params.amountMinor,
              currency: params.currency,
              state: toState,
              selected_gateway: alternateGateway,
              provider_payment_ref: altOutcome.providerPaymentRef,
              trace_id: traceId,
              created_at: new Date().toISOString()
            };

            await IdempotencyManager.completeKey(
              client,
              params.merchantId,
              'PAYMENT_CREATE',
              params.idempotencyKey,
              201,
              failoverResult,
              transaction.id
            );
          });

          failoverSuccess = true;
          return { statusCode: 201, body: failoverResult };
        }
      }
    } catch (failoverErr) {
      logger.warn({ failoverErr }, 'Failover attempt encountered an error');
    }

    // If failover was not possible or failed, transition to FAILED
    await withTransaction(async (client) => {
      await TransactionRepository.transitionState(client, {
        transactionId: transaction.id,
        toState: 'FAILED',
        event: 'TERMINAL_FAIL',
        traceId,
        createdBy: 'failover_exhausted',
        attemptId,
        lastErrorCode: outcome.errorCode
      });
    });

    throw new UnprocessableEntityError(
      outcome.errorMessage || 'Gateway transient error and failover was unsuccessful.',
      'PAYMENT_FAILED',
      { gateway: selectedGateway, gateway_error_code: outcome.errorCode }
    );
  }

  static async capturePayment(params: {
    merchantId: string;
    transactionId: string;
    amountMinor?: string;
    idempotencyKey: string;
    traceId?: string;
  }): Promise<{ statusCode: number; body: any }> {
    const traceId = params.traceId || uuidv4();
    let isCached = false;
    let cachedResult: any = null;

    let transaction!: TransactionRecord;
    let activeAttempt: any = null;
    let requestedAmount: bigint;

    await withTransaction(async (client) => {
      const idempotencyPayload = {
        merchant_id: params.merchantId,
        transaction_id: params.transactionId,
        amount_minor: params.amountMinor || null
      };

      const claim = await IdempotencyManager.claimKey(
        client,
        params.merchantId,
        'CAPTURE',
        params.idempotencyKey,
        idempotencyPayload,
        params.transactionId
      );

      if (claim.isCached) {
        isCached = true;
        cachedResult = { statusCode: claim.statusCode || 200, body: claim.responseBody };
        return;
      }

      transaction = await TransactionRepository.lockForUpdate(client, params.transactionId);

      if (transaction.merchant_id !== params.merchantId) {
        throw new NotFoundError('Transaction not found for this merchant', 'TRANSACTION_NOT_FOUND');
      }

      if (transaction.state !== 'AUTHORISED' && transaction.state !== 'PARTIALLY_CAPTURED') {
        throw new UnprocessableEntityError(
          `Cannot capture transaction in state ${transaction.state}. Must be AUTHORISED or PARTIALLY_CAPTURED.`,
          'INVALID_STATE_FOR_CAPTURE'
        );
      }

      activeAttempt = await PaymentAttemptRepository.findActiveAttempt(client, transaction.id);
      if (!activeAttempt || !activeAttempt.provider_payment_ref) {
        throw new UnprocessableEntityError(
          'No active authorized payment attempt found to capture',
          'NO_ACTIVE_ATTEMPT'
        );
      }

      const authorized = BigInt(transaction.authorized_minor);
      const alreadyCaptured = BigInt(transaction.captured_minor);
      const remainingAuth = authorized - alreadyCaptured;

      requestedAmount = params.amountMinor ? BigInt(params.amountMinor) : remainingAuth;
      if (requestedAmount <= 0n) {
        throw new BadRequestError('Capture amount must be greater than zero', 'INVALID_AMOUNT');
      }
      if (requestedAmount > remainingAuth) {
        throw new UnprocessableEntityError(
          `Requested capture amount ${requestedAmount} exceeds remaining authorized hold ${remainingAuth}`,
          'CAPTURE_AMOUNT_EXCEEDED'
        );
      }

      await TransactionRepository.transitionState(client, {
        transactionId: transaction.id,
        toState: 'CAPTURE_INITIATED',
        event: 'BEGIN_CAPTURE',
        traceId,
        createdBy: 'merchant_api',
        attemptId: activeAttempt.id
      });

      await CaptureRepository.create(client, {
        transaction_id: transaction.id,
        attempt_id: activeAttempt.id,
        operation_key: params.idempotencyKey,
        amount_minor: requestedAmount.toString(),
        trace_id: traceId
      });
    });

    if (isCached) return cachedResult;

    // Call Gateway outside DB transaction
    const adapter = GatewayRegistry.get(activeAttempt.gateway);
    let outcome = await adapter.capture({
      transactionId: params.transactionId,
      attemptId: activeAttempt.id,
      providerPaymentRef: activeAttempt.provider_payment_ref,
      amountMinor: requestedAmount!.toString(),
      traceId,
      idempotencyKey: params.idempotencyKey
    });

    // Check for transient failure (e.g. 502 Bad Gateway) and retry with exponential backoff (Part B FS-04)
    if (outcome.status === 'TRANSIENT_FAILURE') {
      const delays = process.env.TEST_FAST_RETRIES === 'true' ? [10, 20, 40] : [1000, 2000, 4000];
      for (const delay of delays) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        outcome = await adapter.capture({
          transactionId: params.transactionId,
          attemptId: activeAttempt.id,
          providerPaymentRef: activeAttempt.provider_payment_ref,
          amountMinor: requestedAmount!.toString(),
          traceId,
          idempotencyKey: params.idempotencyKey
        });
        if (outcome.status === 'CAPTURED') {
          break;
        }
      }

      // If retries exhausted and still not captured, query gateway status for late capture success
      if (outcome.status !== 'CAPTURED') {
        try {
          const gwStatus = await adapter.fetchPaymentStatus({
            transactionId: params.transactionId,
            attemptId: activeAttempt.id,
            providerPaymentRef: activeAttempt.provider_payment_ref,
            traceId
          });
          if (gwStatus.status === 'CAPTURED') {
            outcome = {
              status: 'CAPTURED',
              providerPaymentRef: activeAttempt.provider_payment_ref,
              rawResponse: gwStatus.rawResponse || { status: 'captured' },
              durationMs: 100
            };
          }
        } catch {
          // Keep failed outcome
        }
      }
    }


    let finalTx: TransactionRecord;
    await withTransaction(async (client) => {
      if (outcome.status === 'CAPTURED') {
        const authorized = BigInt(transaction.authorized_minor);
        const newCaptured = BigInt(transaction.captured_minor) + requestedAmount;
        const isFull = newCaptured >= authorized;
        const toState = isFull ? 'CAPTURED' : 'PARTIALLY_CAPTURED';

        finalTx = await TransactionRepository.transitionState(client, {
          transactionId: transaction.id,
          toState,
          event: isFull ? 'CAPTURE_COMPLETE' : 'CAPTURE_PARTIAL',
          traceId,
          createdBy: 'gateway_capture',
          attemptId: activeAttempt.id,
          captured_minor: newCaptured.toString()
        });

        await CaptureRepository.updateStatus(
          client,
          params.idempotencyKey,
          'SUCCEEDED',
          outcome.providerPaymentRef
        );

        const responseBody = {
          id: finalTx.id,
          state: finalTx.state,
          authorized_minor: finalTx.authorized_minor,
          captured_minor: finalTx.captured_minor,
          trace_id: traceId
        };

        await IdempotencyManager.completeKey(
          client,
          params.merchantId,
          'CAPTURE',
          params.idempotencyKey,
          200,
          responseBody,
          finalTx.id
        );
      } else {
        await TransactionRepository.transitionState(client, {
          transactionId: transaction.id,
          toState: 'CAPTURE_FAILED',
          event: 'CAPTURE_ERROR',
          traceId,
          createdBy: 'gateway_capture',
          attemptId: activeAttempt.id
        });

        await CaptureRepository.updateStatus(client, params.idempotencyKey, 'FAILED');

        const errorBody = {
          error: {
            code: 'CAPTURE_FAILED',
            message: outcome.errorMessage || 'Capture operation declined by gateway',
            request_id: traceId,
            timestamp: new Date().toISOString()
          }
        };

        await IdempotencyManager.failKey(
          client,
          params.merchantId,
          'CAPTURE',
          params.idempotencyKey,
          422,
          errorBody
        );
      }
    });

    if (outcome.status !== 'CAPTURED') {
      throw new UnprocessableEntityError(
        outcome.errorMessage || 'Capture operation failed',
        'CAPTURE_FAILED'
      );
    }


    return {
      statusCode: 200,
      body: {
        id: finalTx!.id,
        state: finalTx!.state,
        authorized_minor: finalTx!.authorized_minor,
        captured_minor: finalTx!.captured_minor,
        trace_id: traceId
      }
    };
  }

  static async voidPayment(params: {
    merchantId: string;
    transactionId: string;
    idempotencyKey: string;
    traceId?: string;
  }): Promise<{ statusCode: number; body: any }> {
    const traceId = params.traceId || uuidv4();
    let isCached = false;
    let cachedResult: any = null;
    let transaction!: TransactionRecord;
    let activeAttempt: any = null;

    await withTransaction(async (client) => {
      const idempotencyPayload = {
        merchant_id: params.merchantId,
        transaction_id: params.transactionId
      };

      const claim = await IdempotencyManager.claimKey(
        client,
        params.merchantId,
        'VOID',
        params.idempotencyKey,
        idempotencyPayload,
        params.transactionId
      );

      if (claim.isCached) {
        isCached = true;
        cachedResult = { statusCode: claim.statusCode || 200, body: claim.responseBody };
        return;
      }

      transaction = await TransactionRepository.lockForUpdate(client, params.transactionId);

      if (transaction.merchant_id !== params.merchantId) {
        throw new NotFoundError('Transaction not found', 'TRANSACTION_NOT_FOUND');
      }

      if (transaction.state !== 'AUTHORISED') {
        throw new UnprocessableEntityError(
          `Cannot void transaction in state ${transaction.state}. Must be AUTHORISED.`,
          'INVALID_STATE_FOR_VOID'
        );
      }

      activeAttempt = await PaymentAttemptRepository.findActiveAttempt(client, transaction.id);
      if (!activeAttempt || !activeAttempt.provider_payment_ref) {
        throw new UnprocessableEntityError('No active attempt to void', 'NO_ACTIVE_ATTEMPT');
      }

      await TransactionRepository.transitionState(client, {
        transactionId: transaction.id,
        toState: 'VOID_INITIATED',
        event: 'BEGIN_VOID',
        traceId,
        createdBy: 'merchant_api',
        attemptId: activeAttempt.id
      });
    });

    if (isCached) return cachedResult;

    const adapter = GatewayRegistry.get(activeAttempt.gateway);
    const outcome = await adapter.void({
      transactionId: params.transactionId,
      attemptId: activeAttempt.id,
      providerPaymentRef: activeAttempt.provider_payment_ref,
      traceId
    });

    let finalTx: TransactionRecord;
    await withTransaction(async (client) => {
      if (outcome.status === 'VOIDED') {
        await PaymentAttemptRepository.updateStatus(client, {
          attempt_id: activeAttempt.id,
          status: 'VOIDED'
        });

        finalTx = await TransactionRepository.transitionState(client, {
          transactionId: transaction.id,
          toState: 'VOIDED',
          event: 'VOID_SUCCESS',
          traceId,
          createdBy: 'gateway_void',
          attemptId: activeAttempt.id,
          authorized_minor: '0'
        });

        const responseBody = {
          id: finalTx.id,
          state: finalTx.state,
          trace_id: traceId
        };

        await IdempotencyManager.completeKey(
          client,
          params.merchantId,
          'VOID',
          params.idempotencyKey,
          200,
          responseBody,
          finalTx.id
        );
      } else {
        throw new UnprocessableEntityError(outcome.errorMessage || 'Void failed', 'VOID_FAILED');
      }
    });

    return {
      statusCode: 200,
      body: {
        id: finalTx!.id,
        state: finalTx!.state,
        trace_id: traceId
      }
    };
  }

  static async refundPayment(params: {
    merchantId: string;
    transactionId: string;
    amountMinor?: string;
    reason?: string;
    idempotencyKey: string;
    traceId?: string;
  }): Promise<{ statusCode: number; body: any }> {
    const traceId = params.traceId || uuidv4();
    let isCached = false;
    let cachedResult: any = null;
    let transaction!: TransactionRecord;
    let activeAttempt: any = null;
    let refundAmount: bigint;

    await withTransaction(async (client) => {
      const idempotencyPayload = {
        merchant_id: params.merchantId,
        transaction_id: params.transactionId,
        amount_minor: params.amountMinor || null,
        reason: params.reason || null
      };

      const claim = await IdempotencyManager.claimKey(
        client,
        params.merchantId,
        'REFUND',
        params.idempotencyKey,
        idempotencyPayload,
        params.transactionId
      );

      if (claim.isCached) {
        isCached = true;
        cachedResult = { statusCode: claim.statusCode || 200, body: claim.responseBody };
        return;
      }

      transaction = await TransactionRepository.lockForUpdate(client, params.transactionId);

      if (transaction.merchant_id !== params.merchantId) {
        throw new NotFoundError('Transaction not found', 'TRANSACTION_NOT_FOUND');
      }

      if (
        transaction.state !== 'CAPTURED' &&
        transaction.state !== 'PARTIALLY_CAPTURED' &&
        transaction.state !== 'SETTLED' &&
        transaction.state !== 'PARTIALLY_REFUNDED'
      ) {
        throw new UnprocessableEntityError(
          `Cannot refund transaction in state ${transaction.state}. Must have captured funds.`,
          'INVALID_STATE_FOR_REFUND'
        );
      }

      const captured = BigInt(transaction.captured_minor);
      const refunded = BigInt(transaction.refunded_minor);
      const reserved = BigInt(transaction.reserved_refund_minor);
      const availableToRefund = captured - (refunded + reserved);

      refundAmount = params.amountMinor ? BigInt(params.amountMinor) : availableToRefund;
      if (refundAmount <= 0n) {
        throw new BadRequestError('Refund amount must be greater than zero', 'INVALID_AMOUNT');
      }
      if (refundAmount > availableToRefund) {
        throw new UnprocessableEntityError(
          `Requested refund amount ${refundAmount} exceeds refundable captured balance ${availableToRefund}`,
          'REFUND_AMOUNT_EXCEEDED'
        );
      }

      // Reserve refund balance
      const newReserved = reserved + refundAmount;

      const attempts = await PaymentAttemptRepository.listByTransactionId(client, transaction.id);
      activeAttempt = attempts.find((a) => a.status === 'CAPTURED' || a.status === 'AUTHORISED');
      if (!activeAttempt || !activeAttempt.provider_payment_ref) {
        throw new UnprocessableEntityError('No provider reference found for refund', 'NO_PROVIDER_REF');
      }

      await TransactionRepository.transitionState(client, {
        transactionId: transaction.id,
        toState: 'REFUND_INITIATED',
        event: 'BEGIN_REFUND',
        traceId,
        createdBy: 'merchant_api',
        attemptId: activeAttempt.id,
        reserved_refund_minor: newReserved.toString()
      });

      await RefundRepository.create(client, {
        transaction_id: transaction.id,
        attempt_id: activeAttempt.id,
        operation_key: params.idempotencyKey,
        amount_minor: refundAmount.toString(),
        currency: transaction.currency,
        reason: params.reason,
        trace_id: traceId
      });
    });

    if (isCached) return cachedResult;

    const adapter = GatewayRegistry.get(activeAttempt.gateway);
    const outcome = await adapter.refund({
      transactionId: params.transactionId,
      attemptId: activeAttempt.id,
      providerPaymentRef: activeAttempt.provider_payment_ref,
      amountMinor: refundAmount!.toString(),
      currency: transaction.currency,
      traceId,
      reason: params.reason,
      idempotencyKey: params.idempotencyKey
    });

    let finalTx: TransactionRecord;
    await withTransaction(async (client) => {
      const currentTx = await TransactionRepository.lockForUpdate(client, transaction.id);
      const reserved = BigInt(currentTx.reserved_refund_minor);

      if (outcome.status === 'REFUNDED') {
        const newReserved = reserved >= refundAmount ? reserved - refundAmount : 0n;
        const newRefunded = BigInt(currentTx.refunded_minor) + refundAmount;
        const isFullRefund = newRefunded >= BigInt(currentTx.captured_minor);
        const toState = isFullRefund ? 'REFUNDED' : 'PARTIALLY_REFUNDED';

        finalTx = await TransactionRepository.transitionState(client, {
          transactionId: currentTx.id,
          toState,
          event: isFullRefund ? 'FULL_REFUND_DONE' : 'PARTIAL_REFUND_DONE',
          traceId,
          createdBy: 'gateway_refund',
          attemptId: activeAttempt.id,
          reserved_refund_minor: newReserved.toString(),
          refunded_minor: newRefunded.toString()
        });

        await RefundRepository.updateStatus(
          client,
          params.idempotencyKey,
          'SUCCEEDED',
          outcome.providerPaymentRef
        );

        const responseBody = {
          id: finalTx.id,
          state: finalTx.state,
          captured_minor: finalTx.captured_minor,
          refunded_minor: finalTx.refunded_minor,
          trace_id: traceId
        };

        await IdempotencyManager.completeKey(
          client,
          params.merchantId,
          'REFUND',
          params.idempotencyKey,
          200,
          responseBody,
          finalTx.id
        );
      } else {
        // Release reservation
        const newReserved = reserved >= refundAmount ? reserved - refundAmount : 0n;

        await TransactionRepository.transitionState(client, {
          transactionId: currentTx.id,
          toState: 'REFUND_FAILED',
          event: 'REFUND_ERROR',
          traceId,
          createdBy: 'gateway_refund',
          attemptId: activeAttempt.id,
          reserved_refund_minor: newReserved.toString()
        });

        await RefundRepository.updateStatus(client, params.idempotencyKey, 'FAILED');

        const errorBody = {
          error: {
            code: 'REFUND_FAILED',
            message: outcome.errorMessage || 'Refund failed at payment gateway',
            request_id: traceId,
            timestamp: new Date().toISOString()
          }
        };

        await IdempotencyManager.failKey(
          client,
          params.merchantId,
          'REFUND',
          params.idempotencyKey,
          422,
          errorBody
        );

        throw new UnprocessableEntityError(outcome.errorMessage || 'Refund failed', 'REFUND_FAILED');
      }
    });

    return {
      statusCode: 200,
      body: {
        id: finalTx!.id,
        state: finalTx!.state,
        captured_minor: finalTx!.captured_minor,
        refunded_minor: finalTx!.refunded_minor,
        trace_id: traceId
      }
    };
  }

  static async getPaymentById(id: string, merchantId?: string): Promise<any> {
    const pool = getPool();
    const tx = await TransactionRepository.findById(pool, id);
    if (!tx) {
      throw new NotFoundError(`Payment with ID ${id} not found`, 'PAYMENT_NOT_FOUND');
    }
    if (merchantId && tx.merchant_id !== merchantId) {
      throw new NotFoundError(`Payment with ID ${id} not found for this merchant`, 'PAYMENT_NOT_FOUND');
    }

    const attempts = await PaymentAttemptRepository.listByTransactionId(pool, tx.id);
    const sanitizedAttempts = attempts.map((a) => ({
      attempt_no: a.attempt_no,
      gateway: a.gateway,
      status: a.status,
      provider_payment_ref: a.provider_payment_ref,
      created_at: a.created_at
    }));

    return {
      id: tx.id,
      merchant_id: tx.merchant_id,
      merchant_order_id: tx.merchant_order_id,
      payment_method: tx.payment_method,
      currency: tx.currency,
      amount_minor: tx.amount_minor,
      capture_mode: tx.capture_mode,
      state: tx.state,
      authorized_minor: tx.authorized_minor,
      captured_minor: tx.captured_minor,
      refunded_minor: tx.refunded_minor,
      attempts: sanitizedAttempts,
      trace_id: tx.trace_id,
      created_at: tx.created_at,
      updated_at: tx.updated_at
    };
  }

  static async getPaymentByMerchantOrderId(merchantOrderId: string, merchantId?: string): Promise<any> {
    const pool = getPool();
    const client = pool;
    const res = await client.query<TransactionRecord>(
      `SELECT * FROM transactions WHERE merchant_order_id = $1 ${merchantId ? 'AND merchant_id = $2' : ''}`,
      merchantId ? [merchantOrderId, merchantId] : [merchantOrderId]
    );

    if (!res.rows[0]) {
      throw new NotFoundError(`Payment with order ID ${merchantOrderId} not found`, 'PAYMENT_NOT_FOUND');
    }

    return this.getPaymentById(res.rows[0].id, merchantId);
  }

  static async getTimeline(id: string): Promise<any[]> {
    const pool = getPool();
    const tx = await TransactionRepository.findById(pool, id);
    if (!tx) {
      throw new NotFoundError(`Payment with ID ${id} not found`, 'PAYMENT_NOT_FOUND');
    }
    return TransactionRepository.getTimeline(pool, id);
  }

  static async getRefunds(id: string): Promise<any[]> {
    const pool = getPool();
    const tx = await TransactionRepository.findById(pool, id);
    if (!tx) {
      throw new NotFoundError(`Payment with ID ${id} not found`, 'PAYMENT_NOT_FOUND');
    }
    return RefundRepository.listByTransactionId(pool, id);
  }

  static async expirePayment(params: {
    transactionId: string;
    merchantId?: string;
    traceId?: string;
  }): Promise<{ statusCode: number; body: any }> {
    const traceId = params.traceId || uuidv4();
    let finalTx!: TransactionRecord;

    await withTransaction(async (client) => {
      const tx = await TransactionRepository.lockForUpdate(client, params.transactionId);
      if (params.merchantId && tx.merchant_id !== params.merchantId) {
        throw new NotFoundError('Transaction not found', 'TRANSACTION_NOT_FOUND');
      }

      if (tx.state !== 'AUTH_INITIATED' && tx.state !== 'AUTHORISED') {
        throw new UnprocessableEntityError(
          `Cannot expire payment in state ${tx.state}. Must be AUTH_INITIATED or AUTHORISED.`,
          'INVALID_STATE_FOR_EXPIRY'
        );
      }

      finalTx = await TransactionRepository.transitionState(client, {
        transactionId: tx.id,
        toState: 'AUTH_EXPIRED',
        event: tx.state === 'AUTH_INITIATED' ? 'MANDATE_EXPIRED' : 'HOLD_EXPIRED',
        traceId,
        createdBy: 'mandate_expiry_worker'
      });
    });

    return {
      statusCode: 200,
      body: {
        id: finalTx.id,
        state: finalTx.state,
        trace_id: traceId,
        message: 'Payment authorization expired'
      }
    };
  }

  static async voidRemainder(params: {
    transactionId: string;
    merchantId?: string;
    idempotencyKey?: string;
    traceId?: string;
  }): Promise<{ statusCode: number; body: any }> {
    const traceId = params.traceId || uuidv4();
    let finalTx!: TransactionRecord;

    await withTransaction(async (client) => {
      const tx = await TransactionRepository.lockForUpdate(client, params.transactionId);
      if (params.merchantId && tx.merchant_id !== params.merchantId) {
        throw new NotFoundError('Transaction not found', 'TRANSACTION_NOT_FOUND');
      }

      if (tx.state !== 'PARTIALLY_CAPTURED') {
        throw new UnprocessableEntityError(
          `Cannot void remainder for transaction in state ${tx.state}. Must be PARTIALLY_CAPTURED.`,
          'INVALID_STATE_FOR_VOID'
        );
      }

      finalTx = await TransactionRepository.transitionState(client, {
        transactionId: tx.id,
        toState: 'CAPTURED',
        event: 'RELEASE_REMAINDER',
        traceId,
        createdBy: 'merchant_api',
        authorized_minor: tx.captured_minor // reduce authorized hold to captured amount
      });
    });


    return {
      statusCode: 200,
      body: {
        id: finalTx.id,
        state: finalTx.state,
        authorized_minor: finalTx.authorized_minor,
        captured_minor: finalTx.captured_minor,
        trace_id: traceId,
        message: 'Remainder hold successfully voided/released'
      }
    };
  }

  static async transitionManualState(params: {
    transactionId: string;
    targetState: TransactionState;
    traceId?: string;
  }): Promise<{ statusCode: number; body: any }> {
    const traceId = params.traceId || uuidv4();
    let updatedTx: TransactionRecord | null = null;
    let transitionError: any = null;

    await withTransaction(async (client) => {
      try {
        updatedTx = await TransactionRepository.transitionState(client, {
          transactionId: params.transactionId,
          toState: params.targetState,
          event: 'MANUAL_TRANSITION',
          traceId,
          createdBy: 'operator_override'
        });
      } catch (err) {
        if (err instanceof InvalidStateTransitionException) {
          // Persist REJECTED_TRANSITION event on this client so it commits
          await client.query(
            `INSERT INTO transaction_state_log (
              transaction_id, from_state, to_state, event,
              metadata, trace_id, created_by
            ) VALUES ($1, $2, $3, 'REJECTED_TRANSITION', $4, $5, 'operator_override')`,
            [
              params.transactionId,
              err.current,
              err.current,
              JSON.stringify({
                attempted_to_state: params.targetState,
                allowed_transitions: err.allowedTransitions
              }),
              traceId
            ]
          );
          transitionError = err;
          return; // Allow commit of the rejected audit log
        }
        throw err;
      }
    });

    if (transitionError) {
      throw transitionError;
    }

    return {
      statusCode: 200,
      body: {
        id: updatedTx!.id,
        state: updatedTx!.state,
        trace_id: traceId
      }
    };
  }

}

