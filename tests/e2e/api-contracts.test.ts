import { describe, it, expect } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { createApp } from '../../src/app.js';
import { config } from '../../src/shared/config/index.js';
import { v4 as uuidv4 } from 'uuid';

const app = createApp();
const merchantKey = config.MERCHANT_API_KEY;
const adminKey = config.ADMIN_API_KEY;

describe('All 23 Prescribed REST API Endpoints Contract Tests', () => {
  let createdPaymentId = '';
  const orderId = `ord_api_test_${Date.now()}`;

  // #1 POST /api/v1/payments
  it('1. POST /api/v1/payments - initiates payment with idempotency', async () => {
    const res = await request(app)
      .post('/api/v1/payments')
      .set('x-api-key', merchantKey)
      .set('Idempotency-Key', uuidv4())
      .send({
        merchant_order_id: orderId,
        amount_minor: '60000',
        currency: 'INR',
        payment_method: 'CARD',
        capture_method: 'MANUAL'
      });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
    expect(res.body.merchant_order_id).toBe(orderId);
    expect(res.body.state).toBe('AUTHORISED');
    createdPaymentId = res.body.id;
  });

  // Negative case for #1
  it('1 (negative). POST /api/v1/payments - rejects without Idempotency-Key', async () => {
    const res = await request(app)
      .post('/api/v1/payments')
      .set('x-api-key', merchantKey)
      .send({
        merchant_order_id: `ord_no_idem_${Date.now()}`,
        amount_minor: '60000',
        currency: 'INR',
        payment_method: 'CARD'
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MISSING_IDEMPOTENCY_KEY');
  });

  // #2 GET /api/v1/payments/:id
  it('2. GET /api/v1/payments/:id - retrieves payment details by ID', async () => {
    const res = await request(app)
      .get(`/api/v1/payments/${createdPaymentId}`)
      .set('x-api-key', merchantKey);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(createdPaymentId);
    expect(res.body).toHaveProperty('attempts');
  });

  // #3 GET /api/v1/payments?merchant_order_id=:id
  it('3. GET /api/v1/payments?merchant_order_id=:id - retrieves payment by order ID', async () => {
    const res = await request(app)
      .get(`/api/v1/payments?merchant_order_id=${orderId}`)
      .set('x-api-key', merchantKey);

    expect(res.status).toBe(200);
    expect(res.body.merchant_order_id).toBe(orderId);
  });

  // #4 POST /api/v1/payments/:id/capture
  it('4. POST /api/v1/payments/:id/capture - captures authorised payment', async () => {
    const res = await request(app)
      .post(`/api/v1/payments/${createdPaymentId}/capture`)
      .set('x-api-key', merchantKey)
      .set('Idempotency-Key', uuidv4())
      .send({ amount_minor: '60000' });

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('CAPTURED');
    expect(res.body.captured_minor).toBe('60000');
  });

  // #5 POST /api/v1/payments/:id/void
  it('5. POST /api/v1/payments/:id/void - voids an authorised payment', async () => {
    // Create new payment to void
    const voidOrd = `ord_to_void_${Date.now()}`;
    const initRes = await request(app)
      .post('/api/v1/payments')
      .set('x-api-key', merchantKey)
      .set('Idempotency-Key', uuidv4())
      .send({
        merchant_order_id: voidOrd,
        amount_minor: '20000',
        currency: 'INR',
        payment_method: 'CARD',
        capture_method: 'MANUAL'
      });

    const voidRes = await request(app)
      .post(`/api/v1/payments/${initRes.body.id}/void`)
      .set('x-api-key', merchantKey)
      .set('Idempotency-Key', uuidv4());

    expect(voidRes.status).toBe(200);
    expect(voidRes.body.state).toBe('VOIDED');
  });

  // #6 POST /api/v1/payments/:id/refund
  it('6. POST /api/v1/payments/:id/refund - initiates refund', async () => {
    const res = await request(app)
      .post(`/api/v1/payments/${createdPaymentId}/refund`)
      .set('x-api-key', merchantKey)
      .set('Idempotency-Key', uuidv4())
      .send({ amount_minor: '15000', reason: 'Customer return' });

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('PARTIALLY_REFUNDED');
    expect(res.body.refunded_minor).toBe('15000');
  });

  // #7 GET /api/v1/payments/:id/refunds
  it('7. GET /api/v1/payments/:id/refunds - lists refunds for a payment', async () => {
    const res = await request(app)
      .get(`/api/v1/payments/${createdPaymentId}/refunds`)
      .set('x-api-key', merchantKey);

    expect(res.status).toBe(200);
    expect(res.body.refunds.length).toBeGreaterThanOrEqual(1);
  });

  // #8 GET /api/v1/payments/:id/timeline
  it('8. GET /api/v1/payments/:id/timeline - retrieves state transition history', async () => {
    const res = await request(app)
      .get(`/api/v1/payments/${createdPaymentId}/timeline`)
      .set('x-api-key', merchantKey);

    expect(res.status).toBe(200);
    expect(res.body.timeline.length).toBeGreaterThanOrEqual(5);
  });

  // #9 POST /api/v1/webhooks/razorpay
  it('9. POST /api/v1/webhooks/razorpay - ingests signed Razorpay webhook', async () => {
    const payload = JSON.stringify({
      id: `evt_rzp_e2e_${Date.now()}`,
      event: 'payment.authorized',
      payload: { payment: { entity: { id: 'pay_rzp_demo', status: 'authorized' } } }
    });
    const sig = crypto.createHmac('sha256', config.RAZORPAY_WEBHOOK_SECRET).update(Buffer.from(payload)).digest('hex');

    const res = await request(app)
      .post('/api/v1/webhooks/razorpay')
      .set('x-razorpay-signature', sig)
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('acknowledged');
  });

  // #10 POST /api/v1/webhooks/stripe
  it('10. POST /api/v1/webhooks/stripe - ingests signed Stripe webhook', async () => {
    const payload = JSON.stringify({
      id: `evt_str_e2e_${Date.now()}`,
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_demo', status: 'succeeded' } }
    });
    const now = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', config.STRIPE_WEBHOOK_SECRET).update(`${now}.${payload}`).digest('hex');

    const res = await request(app)
      .post('/api/v1/webhooks/stripe')
      .set('stripe-signature', `t=${now},v1=${sig}`)
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('acknowledged');
  });

  // #11 POST /api/v1/webhooks/payu
  it('11. POST /api/v1/webhooks/payu - ingests signed PayU webhook', async () => {
    const payload = JSON.stringify({
      mihpayid: `payu_demo_${Date.now()}`,
      status: 'success',
      amount: '100.00'
    });
    const sig = crypto.createHmac('sha512', config.PAYU_WEBHOOK_SECRET).update(Buffer.from(payload)).digest('hex');

    const res = await request(app)
      .post('/api/v1/webhooks/payu')
      .set('x-payu-signature', sig)
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('acknowledged');
  });

  // #12 POST /api/v1/webhooks/upi
  it('12. POST /api/v1/webhooks/upi - ingests signed UPI callback', async () => {
    const payload = JSON.stringify({
      txnId: `upi_demo_${Date.now()}`,
      status: 'SUCCESS'
    });
    const sig = crypto.createHmac('sha256', config.UPI_WEBHOOK_SECRET).update(Buffer.from(payload)).digest('hex');

    const res = await request(app)
      .post('/api/v1/webhooks/upi')
      .set('x-upi-signature', sig)
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('acknowledged');
  });

  // #13 GET /api/v1/gateways
  it('13. GET /api/v1/gateways - lists all configured gateways', async () => {
    const res = await request(app)
      .get('/api/v1/gateways')
      .set('x-api-key', merchantKey);

    expect(res.status).toBe(200);
    expect(res.body.gateways.length).toBeGreaterThanOrEqual(4);
  });

  // #14 GET /api/v1/gateways/:name/health
  it('14. GET /api/v1/gateways/:name/health - gets gateway health and breakers', async () => {
    const res = await request(app)
      .get('/api/v1/gateways/razorpay/health')
      .set('x-api-key', merchantKey);

    expect(res.status).toBe(200);
    expect(res.body.gateway).toBe('razorpay');
    expect(res.body).toHaveProperty('rate_limiter');
    expect(res.body).toHaveProperty('circuit_breakers');
  });

  // #15 GET /api/v1/gateways/:name/metrics
  it('15. GET /api/v1/gateways/:name/metrics - gets gateway metrics', async () => {
    const res = await request(app)
      .get('/api/v1/gateways/razorpay/metrics?window_minutes=60')
      .set('x-api-key', merchantKey);

    expect(res.status).toBe(200);
    expect(res.body.gateway).toBe('razorpay');
    expect(res.body).toHaveProperty('methods');
  });

  // #16 PUT /api/v1/gateways/:name/config
  it('16. PUT /api/v1/gateways/:name/config - updates gateway config (admin authenticated)', async () => {
    const res = await request(app)
      .put('/api/v1/gateways/razorpay/config')
      .set('x-api-key', adminKey)
      .send({ rate_limit_per_second: 250 });

    expect(res.status).toBe(200);
    expect(res.body.config.rate_limit_per_second).toBe(250);
  });

  // #17 GET /api/v1/routing/config
  it('17. GET /api/v1/routing/config - gets routing configuration', async () => {
    const res = await request(app)
      .get('/api/v1/routing/config')
      .set('x-api-key', merchantKey);

    expect(res.status).toBe(200);
    expect(res.body.config).toHaveProperty('weight_success');
  });

  // #18 PUT /api/v1/routing/config
  it('18. PUT /api/v1/routing/config - updates routing weights (must sum to 1.0)', async () => {
    const res = await request(app)
      .put('/api/v1/routing/config')
      .set('x-api-key', adminKey)
      .send({
        weight_success: 0.40,
        weight_latency: 0.20,
        weight_cost: 0.20,
        weight_health: 0.10,
        weight_method_fit: 0.10
      });

    expect(res.status).toBe(200);
    expect(res.body.config.weight_success).toBe('0.40000');
  });

  // #19 POST /api/v1/reconciliation/trigger
  let reconciliationRunId = '';
  it('19. POST /api/v1/reconciliation/trigger - triggers reconciliation', async () => {
    const res = await request(app)
      .post('/api/v1/reconciliation/trigger')
      .set('x-api-key', adminKey)
      .send({ stale_minutes: 5 });

    expect(res.status).toBe(202);
    expect(res.body).toHaveProperty('run_id');
    reconciliationRunId = res.body.run_id;
  });

  // #20 GET /api/v1/reconciliation/reports/:run_id
  it('20. GET /api/v1/reconciliation/reports/:run_id - gets reconciliation report', async () => {
    const res = await request(app)
      .get(`/api/v1/reconciliation/reports/${reconciliationRunId}`)
      .set('x-api-key', adminKey);

    expect(res.status).toBe(200);
    expect(res.body.report.run_id).toBe(reconciliationRunId);
    expect(res.body.report).toHaveProperty('logs');
  });

  // #21 GET /api/v1/analytics/success-rate
  it('21. GET /api/v1/analytics/success-rate - gets gateway success rate analytics', async () => {
    const res = await request(app)
      .get('/api/v1/analytics/success-rate?time_range_minutes=120')
      .set('x-api-key', merchantKey);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
  });

  // #22 GET /api/v1/analytics/volume
  it('22. GET /api/v1/analytics/volume - gets payment volume analytics', async () => {
    const res = await request(app)
      .get('/api/v1/analytics/volume?time_range_minutes=120')
      .set('x-api-key', merchantKey);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
  });

  // #23 GET /api/v1/health
  it('23. GET /api/v1/health - gets system and database health check', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('healthy');
    expect(res.body.database.status).toBe('connected');
  });
});

