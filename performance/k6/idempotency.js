import http from 'k6/http';
import { check } from 'k6';

export const options = {
  vus: 30,
  duration: '20s',
  thresholds: {
    http_req_duration: ['p(99)<10'], // < 10ms for cached idempotency resolution
    http_req_failed: ['rate<0.001'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const API_KEY = __ENV.MERCHANT_API_KEY || 'merchant-secret-key-67890';
const IDEMPOTENCY_KEY = `k6_idem_cached_${Date.now()}`;

// Setup: Prime the cache with the first request
export function setup() {
  const payload = JSON.stringify({
    merchant_order_id: `ord_prime_${Date.now()}`,
    amount_minor: '10000',
    currency: 'INR',
    payment_method: 'CARD',
    capture_method: 'AUTOMATIC',
  });

  const res = http.post(`${BASE_URL}/api/v1/payments`, payload, {
    headers: {
      'Content-Type': 'application/json',
      'x-merchant-id': 'merchant_demo_1',
      'x-api-key': API_KEY,
      'idempotency-key': IDEMPOTENCY_KEY,
    },
  });

  return { key: IDEMPOTENCY_KEY, payload };
}

export default function (data) {
  const params = {
    headers: {
      'Content-Type': 'application/json',
      'x-merchant-id': 'merchant_demo_1',
      'x-api-key': API_KEY,
      'idempotency-key': data.key,
    },
  };

  const res = http.post(`${BASE_URL}/api/v1/payments`, data.payload, params);

  check(res, {
    'cached status is 201': (r) => r.status === 201,
  });
}

