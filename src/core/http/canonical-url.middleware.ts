import type { NextFunction, Request, Response } from 'express';

/**
 * URL canonicalization — collapses the many-encodings-to-one-route ambiguity to
 * a single canonical form computed ONCE, before routing.
 *
 * The confirmed "middleware bypass via URL encoding" class (CVE-2025-69211) and
 * its HEAD sibling (CVE-2026-33011): a guard that protects `/admin` by matching
 * the raw path is defeated by `/%61dmin`, double-encoding (`/%2561dmin`), a
 * trailing slash, dot-segments (`/./admin`, `/x/..%2f admin`), a backslash, or
 * an embedded NUL — the router still dispatches to the admin handler while the
 * guard's compare misses. The root cause is that many wire encodings map to the
 * same route and each layer decodes differently.
 *
 * We register this as the FIRST raw Express middleware (via `app.use` in
 * main.ts), so it precedes routing, guards, and body parsing. The algorithm:
 * decode exactly once → reject any residual '%' (that means it was multi-encoded)
 * → reject control chars / NUL / backslash → iterative RFC-3986 dot-segment
 * removal (a flat loop, never recursive) → drop the trailing slash. The result
 * is stashed on a WeakMap; `canonicalOf()` THROWS if the middleware did not run,
 * so a consumer physically cannot read a non-canonical path. One canonical
 * string means every downstream check sees the same value — the alternate-
 * encoding bypass becomes unrepresentable.
 */

export type AuthMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';

export interface CanonicalRequest {
  /** Decoded, dot-normalized, no trailing slash. The ONLY path downstream may trust. */
  readonly path: string;
  /** HEAD folded to GET; unknown methods rejected upstream. */
  readonly authMethod: AuthMethod;
  readonly rawMethod: string;
}

const CANON = new WeakMap<Request, CanonicalRequest>();

/** Fails loud if canonicalization never ran for this request. */
export function canonicalOf(req: Request): CanonicalRequest {
  const c = CANON.get(req);
  if (c === undefined) {
    throw new Error('canonicalUrlMiddleware did not run before this consumer');
  }
  return c;
}

export type CanonResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: string };

export function canonicalizePath(rawPath: string): CanonResult {
  if (rawPath.length === 0 || rawPath[0] !== '/') {
    return { ok: false, reason: 'path must start with /' };
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath); // decode EXACTLY once
  } catch {
    return { ok: false, reason: 'malformed percent-encoding' };
  }
  // Residual '%' after one decode == multi-encoded (e.g. %2561 -> %61). Refuse.
  if (decoded.includes('%')) {
    return { ok: false, reason: 'multi-encoded path' };
  }
  for (let i = 0; i < decoded.length; i++) {
    const c = decoded.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f || c === 0x5c /* backslash */) {
      return { ok: false, reason: 'illegal character in path' };
    }
  }
  // Iterative RFC-3986 dot-segment removal. No recursion.
  const out: string[] = [];
  for (const seg of decoded.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return { ok: false, reason: 'path traversal above root' };
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return { ok: true, path: '/' + out.join('/') };
}

export function foldMethod(method: string): AuthMethod | null {
  switch (method) {
    case 'GET':
    case 'HEAD':
      return 'GET'; // HEAD is authorized exactly like GET
    case 'POST':
      return 'POST';
    case 'PUT':
      return 'PUT';
    case 'PATCH':
      return 'PATCH';
    case 'DELETE':
      return 'DELETE';
    case 'OPTIONS':
      return 'OPTIONS';
    default:
      return null;
  }
}

/** Register FIRST via app.use(...) so it precedes routing, guards, and body parsers. */
export function canonicalUrlMiddleware(req: Request, res: Response, next: NextFunction): void {
  const qIdx = req.url.indexOf('?');
  const rawPath = qIdx === -1 ? req.url : req.url.slice(0, qIdx);
  const query = qIdx === -1 ? '' : req.url.slice(qIdx); // includes the leading '?'
  const result = canonicalizePath(rawPath);
  if (!result.ok) {
    res.status(400).json({ error: { kind: 'validation', code: 'BAD_PATH', message: result.reason } });
    return;
  }
  const authMethod = foldMethod(req.method);
  if (authMethod === null) {
    res
      .status(405)
      .json({ error: { kind: 'validation', code: 'METHOD_NOT_ALLOWED', message: req.method } });
    return;
  }
  CANON.set(req, { path: result.path, authMethod, rawMethod: req.method });
  // Route on the canonical path too, so the router and every guard operate on
  // ONE identical path. This removes any dependence on Express's own decoding
  // behavior matching ours: `/%61dmin` and `/admin` become the same route, and
  // there is no encoding under which routing and authorization can disagree.
  // `req.originalUrl` is preserved by Express for logging.
  req.url = result.path + query;
  next();
}
