import http from 'k6/http';
import { check } from 'k6';

export const options = {
  vus: 20,
  duration: '30s',
  thresholds: {
    http_req_duration: ['p(95)<200', 'p(99)<500'],
    http_req_failed: ['rate<0.01'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const API_KEY = __ENV.MERCHANT_API_KEY || 'merchant-secret-key-67890';

export default function () {
  const orderId = `k6_init_${Date.now()}_${Math.random()}`;
  const idempotencyKey = `k6_idem_${Date.now()}_${Math.random()}`;

  const payload = JSON.stringify({
    merchant_order_id: orderId,
    amount_minor: '50000',
    currency: 'INR',
    payment_method: 'CARD',
    capture_method: 'MANUAL',
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
    'state is AUTHORISED': (r) => JSON.parse(r.body).state === 'AUTHORISED',
  });
}

