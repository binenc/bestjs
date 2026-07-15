import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { type Observable, throwError, TimeoutError } from 'rxjs';
import { catchError, timeout } from 'rxjs/operators';
import { Errors } from '../errors/app-error';

/**
 * Bounded request budget: three independent hard limits, each on a quantity a
 * peer controls, defending the HTTP edge against exhaustion.
 *
 *  - Body size: body parsers are configured (in main.ts) with an explicit byte
 *    limit counted on the wire, so a lying/absent Content-Length cannot exceed
 *    the cap.
 *  - Idle timeout: `req.setTimeout` destroys any socket that stalls between
 *    bytes — structurally defeating slowloris / slow-post.
 *  - Handler timeout: an RxJS `timeout()` converts a wedged handler into a
 *    typed timeout error (→ 504) instead of an unbounded hang.
 *
 * Server-level requestTimeout / headersTimeout / keepAliveTimeout (also set in
 * main.ts) cap the header-receive and keep-alive windows. Every limit is a
 * statically-known constant from validated config; each violation fails fast.
 */

/** Handler compute budget: a wedged handler becomes a typed timeout, never an unbounded hang. */
@Injectable()
export class RequestTimeoutInterceptor implements NestInterceptor {
  constructor(private readonly ms: number) {}

  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      timeout(this.ms),
      catchError((error: unknown) =>
        error instanceof TimeoutError
          ? throwError(() => Errors.timeout('HANDLER_TIMEOUT', 'handler exceeded its time budget'))
          : throwError(() => error),
      ),
    );
  }
}

/** Idle-socket budget: kill slowloris / slow-post that trickle or stall between bytes. */
export function idleTimeoutMiddleware(ms: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    req.setTimeout(ms, () => {
      if (!res.headersSent) {
        res
          .status(408)
          .json({ error: { kind: 'timeout', code: 'REQUEST_TIMEOUT', message: 'request timed out' } });
      }
      req.destroy();
    });
    next();
  };
}
