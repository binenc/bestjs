/**
 * Bootstrap watchdog — reclassifies a hung startup as a failed startup.
 *
 * NestFactory.create() can hang forever: a useFactory awaiting a promise that
 * never settles (a bad DB DSN with no connect timeout), a deadlocked
 * onModuleInit, or a runtime DI cycle static analysis could not see (async /
 * dynamic providers). The process then sits in a healthy-looking "starting"
 * state indefinitely, the readiness probe never flips, and nothing explains why.
 *
 * We race the build against a hard, config-driven deadline. On timeout we print
 * diagnostics (which provider we were stuck on, plus Nest's partial construction
 * graph) and HARD-EXIT. A soft reject would not help: the hung promise still
 * owns the event loop, so only process.exit() actually kills it instead of
 * leaving a zombie.
 */

export class BootTimeoutError extends Error {
  constructor(
    readonly label: string,
    readonly deadlineMs: number,
    readonly diagnostics: string,
  ) {
    super(`Bootstrap step "${label}" exceeded ${String(deadlineMs)}ms deadline`);
    this.name = 'BootTimeoutError';
  }

  report(): string {
    return [
      '✗ BOOTSTRAP DEADLINE EXCEEDED — hard aborting.',
      `  step:     ${this.label}`,
      `  deadline: ${String(this.deadlineMs)}ms`,
      '  diagnostics:',
      this.diagnostics
        .split('\n')
        .map((l) => `    ${l}`)
        .join('\n'),
      '',
      '  A step that cannot finish in the deadline is a PERMANENT failure',
      '  (never-resolving useFactory, deadlocked onModuleInit, runtime DI cycle).',
      '  Fix the construction graph; do not raise the deadline blindly.',
    ].join('\n');
  }
}

export interface BootDeadlineOptions {
  readonly deadlineMs: number;
  /** Lazily produce diagnostics text; only called on timeout. */
  readonly diagnose: () => string;
}

/**
 * Run an async bootstrap step under a hard deadline. If it does not settle in
 * time, print diagnostics and ABORT — a hung startup is a failed startup.
 */
export async function withBootDeadline<T>(
  label: string,
  step: () => Promise<T>,
  opts: BootDeadlineOptions,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new BootTimeoutError(label, opts.deadlineMs, opts.diagnose()));
    }, opts.deadlineMs);
    timer.unref(); // never keep the loop alive for the watchdog alone
  });

  try {
    return await Promise.race([step(), guard]);
  } catch (error) {
    if (error instanceof BootTimeoutError) {
      process.stderr.write(`\n${error.report()}\n`);
      // The winning promise (the hang) still holds the loop; only a hard exit
      // guarantees we die instead of becoming a zombie.
      process.exit(69); // EX_UNAVAILABLE
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
