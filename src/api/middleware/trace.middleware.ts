import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';

declare global {
  namespace Express {
    interface Request {
      traceId: string;
      merchantId?: string;
      rawBody?: Buffer;
    }
  }
}

export function traceMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-trace-id') || req.header('x-request-id');
  const traceId = incoming && /^[0-9a-f-]{36}$/i.test(incoming) ? incoming : uuidv4();

  req.traceId = traceId;
  res.setHeader('x-trace-id', traceId);
  next();
}

