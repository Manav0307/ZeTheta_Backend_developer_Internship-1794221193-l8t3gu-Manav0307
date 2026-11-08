import { describe, it, expect } from 'vitest';
import { canonicalizePayload, hashPayload } from '../../src/modules/idempotency/index.js';

describe('Idempotency Hashing & Canonicalization Unit Tests', () => {
  it('generates deterministic SHA-256 hash regardless of object key order', () => {
    const payload1 = {
      merchant_order_id: 'ord_123',
      amount_minor: '50000',
      currency: 'INR',
      metadata: { user: 'alice', tier: 'premium' }
    };

    const payload2 = {
      currency: 'INR',
      metadata: { tier: 'premium', user: 'alice' },
      amount_minor: '50000',
      merchant_order_id: 'ord_123'
    };

    const hash1 = hashPayload(payload1);
    const hash2 = hashPayload(payload2);

    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('generates different hash for different payload values', () => {
    const payload1 = { merchant_order_id: 'ord_123', amount_minor: '50000' };
    const payload2 = { merchant_order_id: 'ord_123', amount_minor: '60000' };

    expect(hashPayload(payload1)).not.toBe(hashPayload(payload2));
  });

  it('handles null, undefined, and primitives gracefully', () => {
    expect(canonicalizePayload(null)).toBe('');
    expect(canonicalizePayload(undefined)).toBe('');
    expect(canonicalizePayload(12345)).toBe('12345');
    expect(canonicalizePayload('test-string')).toBe('test-string');
  });
});

