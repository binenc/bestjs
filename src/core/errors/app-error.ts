/**
 * AppError — one closed, exhaustive taxonomy of everything that can go wrong.
 *
 * Every layer maps its failures into this discriminated union. Because it is a
 * closed union keyed by `kind`, `switch`-based mapping is exhaustiveness-checked
 * at compile time (see `eslint switch-exhaustiveness-check`): add a new kind and
 * the compiler forces every mapper — HTTP filter, RPC filter, logger — to handle
 * it. There is no "default: 500 and hope" that silently swallows new cases.
 *
 * Design rules:
 *  - `message` is SAFE to show a client. Never put secrets/PII/stack traces here.
 *  - `cause` is the raw underlying error. It is logged, never serialized to the wire.
 *  - `code` is a stable machine-readable string clients can branch on.
 */

export type ErrorKind =
  | 'validation' // caller sent malformed/invalid input
  | 'unauthenticated' // no/invalid credentials
  | 'forbidden' // authenticated but not allowed
  | 'not_found' // resource does not exist
  | 'conflict' // state conflict (duplicate, version mismatch)
  | 'rate_limited' // too many requests
  | 'timeout' // an operation exceeded its deadline
  | 'unavailable' // a dependency is down / degraded
  | 'internal'; // an unexpected fault — a bug on our side

export interface AppErrorShape {
  readonly kind: ErrorKind;
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
  readonly retryable: boolean;
}

/**
 * A branded error class so `instanceof AppError` is reliable across the codebase
 * and so it can be `throw`n at boundaries where that's ergonomic, while still
 * being usable as a plain value in `Result<T, AppError>`.
 */
export class AppError extends Error implements AppErrorShape {
  readonly kind: ErrorKind;
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;
  override readonly cause?: unknown;
  readonly retryable: boolean;

  constructor(shape: AppErrorShape) {
    super(shape.message);
    this.name = 'AppError';
    this.kind = shape.kind;
    this.code = shape.code;
    if (shape.details !== undefined) this.details = shape.details;
    if (shape.cause !== undefined) this.cause = shape.cause;
    this.retryable = shape.retryable;
  }

  static is(value: unknown): value is AppError {
    return value instanceof AppError;
  }
}

/* --- Constructors: the ONLY sanctioned way to make errors. Keeps codes consistent. --- */

type Extra = { details?: Record<string, unknown>; cause?: unknown };

export const Errors = {
  validation: (code: string, message: string, extra?: Extra): AppError =>
    new AppError({ kind: 'validation', code, message, retryable: false, ...extra }),

  unauthenticated: (code: string, message = 'Authentication required', extra?: Extra): AppError =>
    new AppError({ kind: 'unauthenticated', code, message, retryable: false, ...extra }),

  forbidden: (code: string, message = 'Forbidden', extra?: Extra): AppError =>
    new AppError({ kind: 'forbidden', code, message, retryable: false, ...extra }),

  notFound: (code: string, message = 'Not found', extra?: Extra): AppError =>
    new AppError({ kind: 'not_found', code, message, retryable: false, ...extra }),

  conflict: (code: string, message: string, extra?: Extra): AppError =>
    new AppError({ kind: 'conflict', code, message, retryable: false, ...extra }),

  rateLimited: (code: string, message = 'Too many requests', extra?: Extra): AppError =>
    new AppError({ kind: 'rate_limited', code, message, retryable: true, ...extra }),

  timeout: (code: string, message = 'Operation timed out', extra?: Extra): AppError =>
    new AppError({ kind: 'timeout', code, message, retryable: true, ...extra }),

  unavailable: (code: string, message = 'Service temporarily unavailable', extra?: Extra): AppError =>
    new AppError({ kind: 'unavailable', code, message, retryable: true, ...extra }),

  /** Wrap any unknown thrown value as an internal fault. The cause is logged, never leaked. */
  internal: (cause?: unknown, message = 'Internal server error'): AppError =>
    new AppError({ kind: 'internal', code: 'INTERNAL', message, retryable: false, cause }),
} as const;

/** Normalize ANY caught value into an AppError. The single funnel for `catch (e: unknown)`. */
export function toAppError(value: unknown): AppError {
  if (AppError.is(value)) return value;
  return Errors.internal(value);
}

/** The wire status for each kind. Exhaustive: a new kind won't compile until mapped. */
export function httpStatusFor(kind: ErrorKind): number {
  switch (kind) {
    case 'validation':
      return 400;
    case 'unauthenticated':
      return 401;
    case 'forbidden':
      return 403;
    case 'not_found':
      return 404;
    case 'conflict':
      return 409;
    case 'rate_limited':
      return 429;
    case 'timeout':
      return 504;
    case 'unavailable':
      return 503;
    case 'internal':
      return 500;
  }
}
