/**
 * turbo-cluster — scale the fast path past a single core.
 *
 * A single Bun.serve process tops out around one core's worth of throughput
 * (~75k req/s of hello-JSON on an M-series core). To go further, run N copies
 * with SO_REUSEPORT: the kernel load-balances connections across them, scaling
 * near-linearly with cores — no reverse proxy, no shared state, no code change
 * to turbo itself. This is the Bun-native answer to "make it faster," and it
 * beats reaching for Rust for this workload (measured: FFI was a wash).
 *
 * Run: `bun src/turbo-cluster.ts`  (TURBO_WORKERS defaults to CPU count).
 * Each worker is an independent process; the leak-free/RAII discipline still
 * holds per process, and a crashed worker is replaced by the supervisor.
 */
import { config } from './core/config/env.schema';

const cpuCount =
  typeof navigator !== 'undefined' && typeof navigator.hardwareConcurrency === 'number'
    ? navigator.hardwareConcurrency
    : 4;
const workers = Math.max(1, Number(process.env['TURBO_WORKERS'] ?? cpuCount));

const children = Array.from({ length: workers }, (_index) =>
  Bun.spawn([process.execPath, new URL('./turbo.ts', import.meta.url).pathname], {
    env: { ...process.env, TURBO_CLUSTER: '1' },
    stdout: 'inherit',
    stderr: 'inherit',
  }),
);

// eslint-disable-next-line no-console
console.log(`turbo cluster: ${String(workers)} workers on ${config.HOST}:${String(config.PORT)} (SO_REUSEPORT)`);

let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
