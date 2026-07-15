/**
 * Fatal process guards — "panic = abort" for Node/Bun.
 *
 * An unhandledRejection or uncaughtException leaves the process in undefined
 * state: half-initialized singletons, a dropped DB transaction, a torn promise
 * chain. A process that keeps serving traffic from that state returns corrupt
 * results while the orchestrator, seeing a live process, never restarts it.
 *
 * We treat undefined state as a crash — print the fault and exit non-zero,
 * exactly once. Reconstructing a clean process is the supervisor's job (systemd,
 * Kubernetes, Bun's own restart policy), because only it can do so safely.
 */
export function installFatalGuards(): void {
  let dying = false;
  const die = (kind: string, cause: unknown): void => {
    if (dying) return; // first fault wins; never re-enter (e.g. a fault while dying)
    dying = true;
    const error = cause instanceof Error ? cause : new Error(String(cause));
    process.stderr.write(`\n✗ FATAL (${kind}) — ${error.message}\n${error.stack ?? ''}\n`);
    process.exit(1); // let the supervisor rebuild a clean process
  };

  process.on('unhandledRejection', (reason) => {
    die('unhandledRejection', reason);
  });
  process.on('uncaughtException', (error) => {
    die('uncaughtException', error);
  });
}
