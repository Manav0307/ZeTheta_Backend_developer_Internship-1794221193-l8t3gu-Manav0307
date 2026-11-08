import { describe, it, expect } from 'vitest';
import { isValidTransition, assertValidTransition } from '../../src/modules/state-machine/index.js';
import { UnprocessableEntityError } from '../../src/shared/errors/index.js';

describe('Transaction State Machine Unit Tests', () => {
  it('allows valid transitions according to formal FSM model', () => {
    expect(isValidTransition('CREATED', 'ROUTE_SELECTED')).toBe(true);
    expect(isValidTransition('ROUTE_SELECTED', 'AUTH_INITIATED')).toBe(true);
    expect(isValidTransition('AUTH_INITIATED', 'AUTHORISED')).toBe(true);
    expect(isValidTransition('AUTHORISED', 'CAPTURE_INITIATED')).toBe(true);
    expect(isValidTransition('CAPTURE_INITIATED', 'CAPTURED')).toBe(true);
    expect(isValidTransition('CAPTURED', 'REFUND_INITIATED')).toBe(true);
    expect(isValidTransition('REFUND_INITIATED', 'REFUNDED')).toBe(true);
    expect(isValidTransition('AUTHORISED', 'VOID_INITIATED')).toBe(true);
    expect(isValidTransition('VOID_INITIATED', 'VOIDED')).toBe(true);
  });

  it('rejects invalid transitions and throws UnprocessableEntityError', () => {
    expect(isValidTransition('CREATED', 'CAPTURED')).toBe(false);
    expect(isValidTransition('CREATED', 'REFUNDED')).toBe(false);
    expect(isValidTransition('AUTHORISED', 'REFUNDED')).toBe(false);
    expect(isValidTransition('REFUNDED', 'CAPTURED')).toBe(false);
    expect(isValidTransition('FAILED', 'AUTHORISED')).toBe(false);

    expect(() => {
      assertValidTransition('CREATED', 'REFUNDED', 'INVALID_EVENT');
    }).toThrow(UnprocessableEntityError);
  });

  it('handles partial capture and partial refund edges', () => {
    expect(isValidTransition('CAPTURE_INITIATED', 'PARTIALLY_CAPTURED')).toBe(true);
    expect(isValidTransition('PARTIALLY_CAPTURED', 'CAPTURE_INITIATED')).toBe(true);
    expect(isValidTransition('REFUND_INITIATED', 'PARTIALLY_REFUNDED')).toBe(true);
    expect(isValidTransition('PARTIALLY_REFUNDED', 'REFUND_INITIATED')).toBe(true);
  });
});

