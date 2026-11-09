import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  scenarios: {
    constant_request_rate: {
      executor: 'constant-arrival-rate',
      rate: 100, // 100 req/s
      timeUnit: '1s',
      duration: '5m', // 5 minutes
      preAllocatedVUs: 50,
      maxVUs: 150,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.001'], // error rate < 0.1%
    http_req_duration: ['p(95)<200', 'p(99)<500'], // latency targets
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const API_KEY = __ENV.MERCHANT_API_KEY || 'merchant-secret-key-67890';

export default function () {
  const orderId = `k6_ord_${Date.now()}_${Math.random()}`;
  const idempotencyKey = `k6_idem_${Date.now()}_${Math.random()}`;

  const payload = JSON.stringify({
    merchant_order_id: orderId,
    amount_minor: '10000',
    currency: 'INR',
    payment_method: 'CARD',
    capture_method: 'AUTOMATIC',
  });

  const params = {
    headers: {
      'Content-Type': 'application/json',
      'x-merchant-id': 'merchant_demo_1',
      'x-api-key': API_KEY,
      'idempotency-key': idempotencyKey,
    },
  };

  const res = http.post(`${BASE_URL}/api/v1/payments`, payload, params);

  check(res, {
    'status is 201': (r) => r.status === 201,
    'has payment id': (r) => JSON.parse(r.body).id !== undefined,
  });
}

