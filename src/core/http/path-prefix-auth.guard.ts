import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { CONFIG, type AppConfig } from '../config/env.schema';
import { Errors } from '../errors/app-error';
import { canonicalOf } from './canonical-url.middleware';

/**
 * PathPrefixAuthGuard — authorization that cannot be bypassed by encoding or
 * HEAD tricks, because it never looks at the raw request.
 *
 * It reads `canonicalOf(req)` — the single canonical path and the already
 * HEAD-folded auth method — so HEAD is structurally indistinguishable from GET
 * at the authorization boundary, and `%61`/traversal/trailing-slash variants
 * have already been normalized away. Prefix matching uses exact-segment logic so
 * `/admin` cannot be spoofed by `/administrator`, and because the canonical form
 * has no trailing slash, `/admin` and `/admin/` collapse to one decision.
 *
 * Registered as a global APP_GUARD. It DEPENDS on the canonicalization
 * middleware having run — `canonicalOf` throws otherwise — so this protection
 * can never silently no-op.
 *
 * NOTE: This is the enforcement *skeleton*. Replace `isAuthenticated` with real
 * credential verification (session, JWT via jose, mTLS). The point is the
 * bypass-proof plumbing, not the demo check.
 */
@Injectable()
export class PathPrefixAuthGuard implements CanActivate {
  /** Everything under these canonical prefixes requires authentication. */
  private static readonly PROTECTED: readonly string[] = ['/admin', '/internal'];

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    // Canonical path + HEAD-folded method. Never touch req.url / req.method here.
    const { path } = canonicalOf(req);

    const isProtected = PathPrefixAuthGuard.PROTECTED.some(
      (p) => path === p || path.startsWith(p + '/'),
    );
    if (!isProtected) return true;

    if (!this.isAuthenticated(req)) {
      throw Errors.unauthenticated('AUTH_REQUIRED', 'authentication required for this route');
    }
    return true;
  }

  private isAuthenticated(req: Request): boolean {
    // Placeholder: verify a real credential against this.config.APP_SECRET.
    void this.config;
    const auth = req.headers.authorization;
    return typeof auth === 'string' && auth.length > 0;
  }
}
