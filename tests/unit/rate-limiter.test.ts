import { describe, it, expect, beforeEach } from 'vitest';
import { OutboundRateLimiter } from '../../src/modules/rate-limiter/index.js';

describe('Outbound Rate Limiter Unit Tests', () => {
  beforeEach(() => {
    OutboundRateLimiter.reset();
  });

  it('allows requests within rate limits and reports utilization correctly', () => {
    const status = OutboundRateLimiter.checkLimit('razorpay');
    expect(status.allowed).toBe(true);
    expect(status.limit).toBe(200);

    const consumed = OutboundRateLimiter.consume('razorpay');
    expect(consumed).toBe(true);

    const util = OutboundRateLimiter.getUtilization('razorpay');
    expect(util.limit).toBe(200);
    expect(util.text).toContain('/200 req/sec');
  });

  it('rejects requests when bucket is exhausted', () => {
    // Consume all 100 tokens for stripe
    for (let i = 0; i < 100; i++) {
      OutboundRateLimiter.consume('stripe');
    }

    const check = OutboundRateLimiter.checkLimit('stripe');
    expect(check.allowed).toBe(false);
    expect(check.remaining).toBe(0);
    expect(check.retryAfterMs).toBeGreaterThan(0);
  });
});

