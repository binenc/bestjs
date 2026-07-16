/**
 * bestjs-turbo — the Elysia-class fast path.
 *
 * Same security guarantees as the NestJS app (canonical-URL rewrite, HEAD→GET
 * auth fold, per-IP token-bucket, bounded body, typed AppError envelopes,
 * fail-fast config) but served DIRECTLY on Bun.serve — no Express req/res
 * translation, no DI resolution, no per-request middleware chain. It reuses the
 * exact same pure security primitives as the NestJS stack, so "fast" never means
 * "less safe": the checks are identical, just composed with fewer allocations.
 *
 * Use this for latency-critical / high-RPS routes; keep the NestJS app for the
 * structured business surface. Run: `bun src/turbo.ts`.
 */
import { config } from './core/config/env.schema';
import { AppError, Errors, httpStatusFor } from './core/errors/app-error';
import { canonicalizePath, foldMethod } from './core/http/canonical-url.middleware';
import { TokenBucket } from './core/transport/token-bucket';

const PROTECTED: readonly string[] = ['/admin', '/internal'];

// Per-IP token bucket (bounded map so it can't grow unboundedly — a leak class).
const buckets = new Map<string, TokenBucket>();
const RATE_CAPACITY = Number(process.env['TURBO_RATE_CAPACITY'] ?? 2000);
const RATE_REFILL = Number(process.env['TURBO_RATE_REFILL'] ?? 1000);
function allow(ip: string): boolean {
  let b = buckets.get(ip);
  if (b === undefined) {
    if (buckets.size > 50_000) buckets.clear(); // hard cap on tracked IPs
    b = new TokenBucket({ capacity: RATE_CAPACITY, refillPerSecond: RATE_REFILL });
    buckets.set(ip, b);
  }
  return b.tryRemove(1);
}

type Handler = () => unknown;
// Keyed by "<authMethod> <canonicalPath>" so HEAD dispatches to the GET handler.
const routes = new Map<string, Handler>([
  ['GET /health/live', () => ({ status: 'live', phase: 'ready' })],
  ['GET /demo/users/1', () => ({ id: '1', email: 'ada@example.com' })],
  ['GET /admin/secret', () => ({ ok: true, data: 'top secret' })],
]);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
function fail(e: AppError): Response {
  const status = httpStatusFor(e.kind);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (e.retryable) headers['retry-after'] = '1';
  return new Response(JSON.stringify({ error: { kind: e.kind, code: e.code, message: e.message } }), {
    status,
    headers,
  });
}

// Allocation-free path extraction (no `new URL`): slice between the host and the '?'.
function pathOf(rawUrl: string): string {
  const schemeEnd = rawUrl.indexOf('://');
  const hostStart = schemeEnd === -1 ? 0 : schemeEnd + 3;
  const pathStart = rawUrl.indexOf('/', hostStart);
  if (pathStart === -1) return '/';
  const qIdx = rawUrl.indexOf('?', pathStart);
  return qIdx === -1 ? rawUrl.slice(pathStart) : rawUrl.slice(pathStart, qIdx);
}

const server = Bun.serve({
  port: config.PORT,
  hostname: config.HOST,
  // SO_REUSEPORT: run this file N times on the same port and the kernel
  // load-balances across processes — near-linear scaling with cores, the real
  // way past a single core's ~75k/s ceiling. Enable with TURBO_CLUSTER=1.
  reusePort: process.env['TURBO_CLUSTER'] === '1',
  // Bun-native body cap: a request larger than this is rejected before it lands.
  maxRequestBodySize: config.BODY_LIMIT_BYTES,
  fetch(req, srv) {
    try {
      // 1) Canonicalize (decode once, reject multi-encoding/traversal/control chars).
      const canon = canonicalizePath(pathOf(req.url));
      if (!canon.ok) return fail(Errors.validation('BAD_PATH', canon.reason));

      // 2) Fold HEAD→GET for auth + routing; reject unknown methods.
      const authMethod = foldMethod(req.method);
      if (authMethod === null) return fail(Errors.validation('METHOD_NOT_ALLOWED', req.method));

      // 3) Per-IP backpressure.
      const ip = srv.requestIP(req)?.address ?? 'unknown';
      if (!allow(ip)) return fail(Errors.rateLimited('RATE_LIMITED'));

      // 4) Bypass-proof auth on the canonical path.
      const path = canon.path;
      if (PROTECTED.some((p) => path === p || path.startsWith(p + '/'))) {
        const auth = req.headers.get('authorization');
        if (auth === null || auth.length === 0) {
          return fail(Errors.unauthenticated('AUTH_REQUIRED', 'authentication required'));
        }
      }

      // 5) Route on the canonical path (HEAD shares the GET handler, no body).
      const handler = routes.get(authMethod + ' ' + path);
      if (handler === undefined) return fail(Errors.notFound('NOT_FOUND', `no route ${path}`));
      if (req.method === 'HEAD') return new Response(null, { status: 200 });
      return json(handler());
    } catch (cause) {
      return fail(cause instanceof AppError ? cause : Errors.internal(cause));
    }
  },
});

// eslint-disable-next-line no-console
console.log(`bestjs-turbo listening on ${server.hostname}:${String(server.port)} [${config.NODE_ENV}]`);
