import { Request } from 'express';

export type MockResponseType = 'success' | 'timeout' | 'server-error' | 'decline' | 'rate-limit';

export interface ParsedMockControls {
  responseMode?: MockResponseType;
  delayMs: number;
  isGatewayDown: boolean;
  retryAfterSeconds: number;
}

export class MockControlParser {
  /**
   * Extracts and validates mock control headers from an Express Request or raw header map
   */
  static parse(reqOrHeaders: Request | Record<string, string | string[] | undefined>): ParsedMockControls {
    const getHeader = (name: string): string | undefined => {
      if ('header' in reqOrHeaders && typeof reqOrHeaders.header === 'function') {
        return reqOrHeaders.header(name) || reqOrHeaders.header(name.toLowerCase());
      }
      const map = reqOrHeaders as Record<string, string | string[] | undefined>;
      const lower = name.toLowerCase();
      const val = map[name] ?? map[lower];
      if (Array.isArray(val)) return val[0];
      return val;
    };

    // 1. Response Mode
    const rawMode = getHeader('X-Mock-Response')?.trim().toLowerCase();
    let responseMode: MockResponseType | undefined;
    if (rawMode) {
      if (['success', 'timeout', 'server-error', 'decline', 'rate-limit'].includes(rawMode)) {
        responseMode = rawMode as MockResponseType;
      }
    }

    // 2. Delay
    const rawDelay = getHeader('X-Mock-Delay-Ms');
    let delayMs = 0;
    if (rawDelay) {
      const parsed = parseInt(rawDelay, 10);
      if (!isNaN(parsed) && parsed >= 0) {
        // Bound delay to max 35000 ms
        delayMs = Math.min(parsed, 35000);
      }
    }

    // 3. Gateway Down
    const rawDown = getHeader('X-Mock-Gateway-Down')?.trim().toLowerCase();
    const isGatewayDown = rawDown === 'true' || rawDown === '1';

    // 4. Retry-After header (default 30s if rate-limited)
    const rawRetryAfter = getHeader('Retry-After');
    let retryAfterSeconds = 30;
    if (rawRetryAfter) {
      const parsed = parseInt(rawRetryAfter, 10);
      if (!isNaN(parsed) && parsed > 0) {
        retryAfterSeconds = parsed;
      }
    }

    return {
      responseMode,
      delayMs,
      isGatewayDown,
      retryAfterSeconds
    };
  }
}

