import { Request, Response, NextFunction } from 'express';
import { UnauthorizedError, ForbiddenError } from '../../shared/errors/index.js';
import { config } from '../../shared/config/index.js';

export function merchantAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const apiKey = req.header('x-api-key') || req.header('authorization')?.replace(/^Bearer\s+/i, '');

  if (!apiKey) {
    throw new UnauthorizedError('Missing merchant API authentication key', 'UNAUTHORIZED');
  }

  // Allow standard demo merchant key or configurable key
  if (apiKey !== config.MERCHANT_API_KEY && apiKey !== config.ADMIN_API_KEY && apiKey !== 'merchant-demo-key') {
    throw new UnauthorizedError('Invalid merchant API key', 'INVALID_CREDENTIALS');
  }

  // Assign merchantId from header if provided (e.g. multi-merchant testing) or default
  req.merchantId = req.header('x-merchant-id') || 'merchant_demo_1';
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

