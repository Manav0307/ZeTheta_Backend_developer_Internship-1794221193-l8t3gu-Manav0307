import express, { Request, Response } from 'express';
import { RazorpayMockController } from './razorpay.mock.js';
import { StripeMockController } from './stripe.mock.js';
import { PayUMockController } from './payu.mock.js';
import { UpiMockController } from './upi.mock.js';
import { MockStateStore } from './mock-state.store.js';
import { MockSignatures } from './mock-signatures.js';

export function createMockGatewayApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Health
  app.get(['/health', '/mock/health'], (req: Request, res: Response) => {
    res.status(200).json({ status: 'ok', service: 'mock-gateways', timestamp: new Date().toISOString() });
  });

  // Admin Reset
  app.post(['/admin/reset', '/mock/admin/reset'], (req: Request, res: Response) => {
    MockStateStore.reset();
    PayUMockController.resetCaptureAttemptCount();
    res.status(200).json({ status: 'reset_successful' });
  });

  // Admin Set Scenario
  app.put(['/:gateway/admin/scenarios/:scenarioId', '/mock/:gateway/admin/scenarios/:scenarioId'], (req: Request, res: Response) => {
    const gateway = String(req.params.gateway);
    const scenarioId = String(req.params.scenarioId);
    const body = req.body || {};
    if (body.override) {
      MockStateStore.setGatewayOverride(gateway, body.override);
    }
    if (body.scenarioParams) {
      for (const [k, v] of Object.entries(body.scenarioParams)) {
        MockStateStore.setScenarioParam(k, v);
      }
    }
    res.status(200).json({ status: 'configured', gateway, scenarioId });
  });

  // Admin Emit Signed Webhook Event
  app.post(['/:gateway/admin/events/emit', '/mock/:gateway/admin/events/emit'], async (req: Request, res: Response) => {
    const gateway = String(req.params.gateway);
    const { eventType, providerReference, amountMinor, targetUrl } = req.body;
    const url = targetUrl || `http://localhost:3000/api/v1/webhooks/${gateway.toLowerCase()}`;

    let payload: any = {};
    let headers: Record<string, string> = { 'Content-Type': 'application/json' };

    if (gateway.toLowerCase() === 'razorpay') {
      payload = {
        event: eventType || 'payment.captured',
        payload: {
          payment: {
            entity: {
              id: providerReference || `pay_${Date.now()}`,
              amount: Number(amountMinor || 10000),
              currency: 'INR',
              status: 'captured'
            }
          }
        }
      };
      const rawBody = JSON.stringify(payload);
      headers['x-razorpay-signature'] = MockSignatures.generateRazorpaySignature(rawBody);
    } else if (gateway.toLowerCase() === 'stripe') {
      payload = {
        id: `evt_str_${Date.now()}`,
        object: 'event',
        type: eventType || 'payment_intent.succeeded',
        data: {
          object: {
            id: providerReference || `pi_${Date.now()}`,
            amount: Number(amountMinor || 10000),
            currency: 'inr',
            status: 'succeeded'
          }
        }
      };
      const rawBody = JSON.stringify(payload);
      headers['stripe-signature'] = MockSignatures.generateStripeSignature(rawBody);
    } else if (gateway.toLowerCase() === 'payu') {
      payload = {
        status: 'success',
        mihpayid: providerReference || `payu_${Date.now()}`,
        amount: String(amountMinor || '10000'),
        txnid: `tx_${Date.now()}`
      };
      const hash = MockSignatures.generatePayUHash({
        txnid: payload.txnid,
        amount: payload.amount,
        productinfo: 'Test',
        firstname: 'Customer',
        email: 'test@example.com',
        status: 'success'
      });
      payload.hash = hash;
    } else if (gateway.toLowerCase() === 'upi') {
      payload = {
        txnId: providerReference || `upi_${Date.now()}`,
        status: 'SUCCESS',
        amount: Number(amountMinor || 10000)
      };
      headers['x-upi-signature'] = MockSignatures.generateUpiSignature(JSON.stringify(payload));
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      });
      const resBody = await response.json().catch(() => ({}));
      res.status(200).json({ status: 'emitted', responseStatus: response.status, responseBody: resBody });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to dispatch webhook', message: err.message });
    }
  });

  // Authorize Route
  app.post(['/:gateway/authorize', '/mock/:gateway/authorize'], async (req: Request, res: Response) => {
    const gw = String(req.params.gateway).toLowerCase();
    if (gw === 'razorpay') return RazorpayMockController.handleAuthorize(req, res);
    if (gw === 'stripe') return StripeMockController.handleAuthorize(req, res);
    if (gw === 'payu') return PayUMockController.handleAuthorize(req, res);
    if (gw === 'upi') return UpiMockController.handleAuthorize(req, res);
    res.status(404).json({ error: `Unsupported gateway ${gw}` });
  });

  // Capture Route
  app.post(['/:gateway/capture', '/mock/:gateway/capture'], async (req: Request, res: Response) => {
    const gw = String(req.params.gateway).toLowerCase();
    if (gw === 'razorpay') return RazorpayMockController.handleCapture(req, res);
    if (gw === 'stripe') return StripeMockController.handleCapture(req, res);
    if (gw === 'payu') return PayUMockController.handleCapture(req, res);
    res.status(404).json({ error: `Unsupported gateway ${gw}` });
  });

  // Void Route
  app.post(['/:gateway/void', '/mock/:gateway/void'], async (req: Request, res: Response) => {
    const gw = String(req.params.gateway).toLowerCase();
    if (gw === 'stripe') return StripeMockController.handleVoid(req, res);
    // Generic void
    const { provider_payment_ref, payment_intent_id } = req.body;
    const ref = provider_payment_ref || payment_intent_id;
    MockStateStore.updatePaymentStatus(ref, 'VOIDED');
    res.status(200).json({ status: 'voided', providerReference: ref });
  });

  // Refund Route
  app.post(['/:gateway/refund', '/mock/:gateway/refund'], async (req: Request, res: Response) => {
    const gw = String(req.params.gateway).toLowerCase();
    if (gw === 'razorpay') return RazorpayMockController.handleRefund(req, res);
    if (gw === 'stripe') return StripeMockController.handleRefund(req, res);
    if (gw === 'payu') return PayUMockController.handleRefund(req, res);
    if (gw === 'upi') return UpiMockController.handleRefund(req, res);
    res.status(404).json({ error: `Unsupported gateway ${gw}` });
  });

  // Payments Status Lookup (Late Success Pattern)
  app.get(['/:gateway/payments/:providerReference', '/mock/:gateway/payments/:providerReference'], async (req: Request, res: Response) => {
    const gw = String(req.params.gateway).toLowerCase();
    if (gw === 'payu') return PayUMockController.handleStatus(req, res);
    if (gw === 'upi') return UpiMockController.handleStatus(req, res);

    const providerReference = String(req.params.providerReference);
    const payment = MockStateStore.getPayment(providerReference);
    if (!payment) {
      return res.status(404).json({ error: 'Payment not found on gateway' });
    }
    res.status(200).json({
      id: payment.providerReference,
      status: payment.status.toLowerCase(),
      amount: payment.amountMinor,
      captured_amount: payment.capturedMinor
    });
  });

  // Settlements Lookup
  app.get(['/:gateway/settlements/:providerReference', '/mock/:gateway/settlements/:providerReference'], async (req: Request, res: Response) => {
    const providerReference = String(req.params.providerReference);
    const settlement = MockStateStore.getSettlement(providerReference);
    if (!settlement) {
      return res.status(404).json({ error: 'Settlement record not found' });
    }
    res.status(200).json(settlement);
  });

  return app;
}

// Standalone execution support
const PORT = process.env.MOCK_PORT ? parseInt(process.env.MOCK_PORT, 10) : 4100;
if (process.argv[1]?.includes('mock-gateways') || process.argv[1]?.includes('gateway-mocks/app')) {
  const app = createMockGatewayApp();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[mock-gateways] Mock gateway service running on port ${PORT}`);
  });
}

