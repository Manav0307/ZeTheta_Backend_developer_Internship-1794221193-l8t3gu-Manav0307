import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { AppError, InvalidStateTransitionException } from '../../shared/errors/index.js';
import { logger } from '../../shared/logging/logger.js';

export function errorMiddleware(
  err: any,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  next: NextFunction
): void {
  const requestId = req.traceId || 'unknown';
  const timestamp = new Date().toISOString();

  // 1. Zod Validation Error
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request input parameters.',
        details: { issues: err.issues },
        request_id: requestId,
        timestamp
      }
    });
    return;
  }

  // 2. Specific InvalidStateTransitionException handler (Part B FS-15)
  if (err instanceof InvalidStateTransitionException) {
    res.status(422).json({
      error: 'INVALID_STATE_TRANSITION',
      code: 'INVALID_STATE_TRANSITION',
      message: err.message,
      current: err.current,
      requested: err.requested,
      allowedTransitions: err.allowedTransitions,
      details: {
        current: err.current,
        requested: err.requested,
        allowedTransitions: err.allowedTransitions
      },
      request_id: requestId,
      timestamp
    });
    return;
  }

  // 3. Custom AppError
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        details: err.details || {},
        request_id: requestId,
        timestamp
      }
    });
    return;
  }


  // 3. PostgreSQL constraint violations
  if (err.code === '23505') {
    // Unique violation
    res.status(409).json({
      error: {
        code: 'CONFLICT',
        message: 'A resource with these unique parameters already exists.',
        details: { detail: err.detail },
        request_id: requestId,
        timestamp
      }
    });
    return;
  }

  if (err.code === '23514') {
    // Check constraint violation
    res.status(422).json({
      error: {
        code: 'CONSTRAINT_VIOLATION',
        message: 'Request violated database invariant constraints.',
        details: { constraint: err.constraint },
        request_id: requestId,
        timestamp
      }
    });
    return;
  }

  // 4. Default 500
  logger.error({ err, trace_id: requestId }, 'Unhandled application error');
  res.status(500).json({
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected internal error occurred.',
      details: {},
      request_id: requestId,
      timestamp
    }
  });
}

