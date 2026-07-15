import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppError, Errors, httpStatusFor, type ErrorKind } from './app-error';

/**
 * The ONE place errors become HTTP responses.
 *
 * This resolves the real NestJS lifecycle constraint that guards run *before*
 * interceptors, so an interceptor can never observe an error a guard throws.
 * The fix is architectural: don't try to catch errors in interceptors at all.
 * Guards, pipes, controllers, and services all just `throw` (or return an
 * `Err`); every one of those paths converges HERE, in an exception filter, which
 * NestJS invokes no matter which stage failed. Error→response mapping lives in
 * exactly one location, so there is nothing to duplicate and nothing to miss.
 *
 * The client always gets a stable, safe shape. Internal faults are logged with
 * their cause and stack; the wire body never leaks them.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    const { appError, status } = this.normalize(exception);
    const requestId = this.requestId(req);

    // Observability: log the FULL truth (cause, stack) server-side. 5xx at error
    // level, 4xx at debug — client mistakes shouldn't page an on-call engineer.
    const logPayload = {
      requestId,
      kind: appError.kind,
      code: appError.code,
      method: req.method,
      path: req.originalUrl,
      cause: appError.cause,
    };
    if (status >= 500) {
      this.logger.error(
        `${appError.code} ${req.method} ${req.originalUrl}`,
        appError.cause instanceof Error ? appError.cause.stack : undefined,
        JSON.stringify(logPayload),
      );
    } else {
      this.logger.debug(`${appError.code} ${req.method} ${req.originalUrl}`);
    }

    if (res.headersSent) return; // response already streaming; nothing safe to do.

    if (appError.retryable) res.setHeader('Retry-After', '1');
    res.status(status).json({
      error: {
        kind: appError.kind,
        code: appError.code,
        message: appError.message, // safe by construction (see AppError contract)
        ...(appError.details ? { details: appError.details } : {}),
        requestId,
      },
    });
  }

  /**
   * Funnel every possible thrown shape into the one taxonomy, preserving the
   * authoritative HTTP status of each source (never re-derive an HttpException's
   * status from a lossy kind mapping — that would turn a 408 into a 400).
   */
  private normalize(exception: unknown): { appError: AppError; status: number } {
    if (AppError.is(exception)) {
      return { appError: exception, status: httpStatusFor(exception.kind) };
    }

    // Translate framework HttpExceptions (e.g. from built-in pipes/guards).
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const message =
        typeof response === 'string'
          ? response
          : ((response as { message?: unknown }).message?.toString() ?? exception.message);
      const appError = new AppError({
        kind: kindFromStatus(status),
        code: `HTTP_${String(status)}`,
        message,
        retryable: status === 429 || status === 503 || status === 504,
        cause: exception,
      });
      return { appError, status };
    }

    // Anything else is an unexpected fault — a bug on our side.
    return { appError: Errors.internal(exception), status: 500 };
  }

  private requestId(req: Request): string {
    const header = req.headers['x-request-id'];
    if (typeof header === 'string' && header.length > 0) return header;
    if (Array.isArray(header) && header[0]) return header[0];
    return crypto.randomUUID();
  }
}

function kindFromStatus(status: number): ErrorKind {
  switch (status) {
    case 400:
      return 'validation';
    case 401:
      return 'unauthenticated';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 429:
      return 'rate_limited';
    case 503:
      return 'unavailable';
    case 504:
      return 'timeout';
    default:
      return status >= 500 ? 'internal' : 'validation';
  }
}
