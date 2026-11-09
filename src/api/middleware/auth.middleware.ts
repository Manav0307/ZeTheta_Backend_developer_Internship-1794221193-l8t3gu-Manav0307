import { Request, Response, NextFunction } from 'express';
import { UnauthorizedError, ForbiddenError } from '../../shared/errors/index.js';
import { config } from '../../shared/config/index.js';

/** Extract merchant id from an API key formatted as `key_test_<merchantId>` */
function extractMerchantFromTestKey(apiKey: string): string | null {
  const match = apiKey.match(/^key_test_(.+)$/);
  return match ? match[1] : null;
}

export function merchantAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const apiKey = req.header('x-api-key') || req.header('authorization')?.replace(/^Bearer\s+/i, '');

  if (!apiKey) {
    throw new UnauthorizedError('Missing merchant API authentication key', 'UNAUTHORIZED');
  }

  // Allow standard keys and test-pattern keys (key_test_<merchantId>)
  const isConfigKey = apiKey === config.MERCHANT_API_KEY || apiKey === config.ADMIN_API_KEY || apiKey === 'merchant-demo-key';
  const testMerchant = extractMerchantFromTestKey(apiKey);

  if (!isConfigKey && !testMerchant) {
    throw new UnauthorizedError('Invalid merchant API key', 'INVALID_CREDENTIALS');
  }

  // Assign merchantId: prefer explicit x-merchant-id header, then decode from test key, then default
  if (req.header('x-merchant-id')) {
    req.merchantId = req.header('x-merchant-id')!;
  } else if (testMerchant) {
    req.merchantId = testMerchant;
  } else {
    req.merchantId = 'merchant_demo_1';
  }

  next();
}

export function adminAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const apiKey = req.header('x-api-key') || req.header('authorization')?.replace(/^Bearer\s+/i, '');

  if (!apiKey) {
    throw new UnauthorizedError('Missing admin API key', 'UNAUTHORIZED');
  }

  if (apiKey !== config.ADMIN_API_KEY) {
    throw new ForbiddenError('Admin API key required for this operation', 'FORBIDDEN');
  }

  next();
}
