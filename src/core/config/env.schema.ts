import { z } from 'zod';

/**
 * Typed, validated configuration — the program panics at boot if the
 * environment cannot produce a valid config, exactly like a Rust binary that
 * refuses to start on a bad `Config::from_env()`. A missing `APP_SECRET` is a
 * boot-time crash with a precise message, never an `undefined` that surfaces as
 * a security hole under load three weeks later.
 *
 * Nothing else in the codebase may read `process.env` directly. Everything
 * imports `config` (or injects it via the `CONFIG` token), so "read an
 * unvalidated, untyped variable" is structurally unrepresentable.
 */

/** Parse "true"/"false"/"1"/"0" env strings into real booleans, strictly. */
const boolFromEnv = z
  .string()
  .transform((s) => s.trim().toLowerCase())
  .pipe(z.enum(['true', 'false', '1', '0']))
  .transform((s) => s === 'true' || s === '1');

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // --- Lifecycle deadlines (the bootstrap/shutdown watchdogs read these) ---
  /** Hard deadline for NestFactory.create(). A DI hang past this is a crash, not a wait. */
  BOOTSTRAP_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(15_000),
  /** Time to let the load balancer observe a failing readiness probe before closing sockets. */
  SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).max(120_000).default(5_000),
  /** Hard wall-clock budget for the ENTIRE shutdown. Keep below the orchestrator's SIGKILL window. */
  SHUTDOWN_DEADLINE_MS: z.coerce.number().int().min(1000).max(120_000).default(15_000),
  /** Per-resource teardown budget so one wedged handle cannot stall the whole drain. */
  RESOURCE_DISPOSE_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5_000),

  // --- HTTP edge limits (bounded I/O) ---
  BODY_LIMIT_BYTES: z.coerce.number().int().min(1024).max(64 * 1024 * 1024).default(1_048_576),
  /** Idle-socket + whole-request receive window (slowloris / slow-post defense). */
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600_000).default(30_000),
  /** Header-receive window. */
  HEADERS_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(10_000),
  /** Idle keep-alive window. */
  KEEPALIVE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(5_000),
  /** Per-handler compute budget: a wedged handler becomes 504, never an unbounded hang. */
  HANDLER_TIMEOUT_MS: z.coerce.number().int().min(100).max(600_000).default(20_000),

  // --- Observability ---
  MEM_WATERMARK_INTERVAL_MS: z.coerce.number().int().min(1000).max(600_000).default(30_000),
  /** Alertable RSS ceiling in bytes. 0 disables. Set below the container memory limit. */
  MEM_RSS_CEILING_BYTES: z.coerce.number().int().min(0).default(0),

  // --- Security ---
  APP_SECRET: z.string().min(32, 'APP_SECRET must be at least 32 characters'),
  TRUST_PROXY: boolFromEnv.default(false),
});

/** The single, frozen, fully-typed config shape used everywhere. */
export type AppConfig = Readonly<z.infer<typeof envSchema>>;

/** DI token for injecting config: `constructor(@Inject(CONFIG) cfg: AppConfig) {}`. */
export const CONFIG = Symbol('bestjs.config');

/**
 * Validate `source` (defaults to process.env) or die. On failure this prints a
 * human-readable list of every problem and exits non-zero — the process never
 * limps forward in a half-configured state. Exposed as a function so tests can
 * validate arbitrary inputs without exiting.
 */
export function loadConfig(source: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    // Deliberately using process.stderr, not the logger: this runs before the
    // logger (which itself depends on validated config) can exist.
    process.stderr.write(
      `\n✗ Invalid configuration — refusing to start.\n${issues}\n\n` +
        `Fix your environment (see .env.example) and try again.\n\n`,
    );
    process.exit(78); // EX_CONFIG (sysexits.h): orchestrators can distinguish this.
  }
  return Object.freeze(parsed.data);
}

/**
 * Frozen, fully-typed config, evaluated EAGERLY at import time. Importing this
 * module is enough to abort a misconfigured process before Nest starts — which
 * is exactly why `main.ts` imports it on its first line. Every other module
 * imports THIS binding (or injects the `CONFIG` token) instead of touching
 * `process.env`.
 */
export const config: AppConfig = loadConfig();
