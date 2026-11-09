export interface ApiErrorDetails {
  gateway?: string;
  gateway_error_code?: string;
  gateway_error_description?: string;
  suggestion?: string;
  [key: string]: any;
}

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: ApiErrorDetails;

  constructor(
    code: string,
    message: string,
    statusCode: number = 400,
    details?: ApiErrorDetails
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class BadRequestError extends AppError {
  constructor(message: string, code: string = 'BAD_REQUEST', details?: ApiErrorDetails) {
    super(code, message, 400, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message: string = 'Unauthorized', code: string = 'UNAUTHORIZED') {
    super(code, message, 401);
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string = 'Forbidden', code: string = 'FORBIDDEN') {
    super(code, message, 403);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string = 'Resource not found', code: string = 'NOT_FOUND') {
    super(code, message, 404);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, code: string = 'CONFLICT', details?: ApiErrorDetails) {
    super(code, message, 409, details);
  }
}

export class UnprocessableEntityError extends AppError {
  constructor(message: string, code: string = 'UNPROCESSABLE_ENTITY', details?: ApiErrorDetails) {
    super(code, message, 422, details);
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message: string = 'Rate limit exceeded', code: string = 'RATE_LIMIT_EXCEEDED', details?: ApiErrorDetails) {
    super(code, message, 429, details);
  }
}

export class InternalServerError extends AppError {
  constructor(message: string = 'Internal server error', code: string = 'INTERNAL_ERROR', details?: ApiErrorDetails) {
    super(code, message, 500, details);
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message: string = 'Service unavailable', code: string = 'SERVICE_UNAVAILABLE', details?: ApiErrorDetails) {
    super(code, message, 503, details);
  }
}

export class InvalidStateTransitionException extends UnprocessableEntityError {
  public readonly allowedTransitions: string[];
  public readonly current: string;
  public readonly requested: string;

  constructor(
    current: string,
    requested: string,
    allowedTransitions: string[],
    details?: ApiErrorDetails
  ) {
    super(
      `Illegal transition from state ${current} to ${requested}. Allowed transitions: [${allowedTransitions.join(', ')}]`,
      'INVALID_STATE_TRANSITION',
      {
        ...details,
        error: 'INVALID_STATE_TRANSITION',
        current,
        requested,
        allowedTransitions
      }
    );
    this.name = 'InvalidStateTransitionException';
    this.allowedTransitions = allowedTransitions;
    this.current = current;
    this.requested = requested;
  }
}


