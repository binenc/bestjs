import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { CONFIG, type AppConfig } from '../config/env.schema';

/**
 * ResourceRegistry — the single RAII owner for every non-GC resource.
 *
 * The "slow leak in a long-running process" class: each setInterval, event
 * listener, subscription, and pool connection that is created but never torn
 * down accumulates. GC cannot reclaim them because a live root (the event loop,
 * an emitter, a socket) still references them. RSS climbs for days, then the
 * OOM-killer fires at 3am. The root cause is that teardown is optional and lives
 * far from allocation, so it silently rots out of sync.
 *
 * Here, acquisition and teardown are one atomic act: every long-lived resource
 * MUST register a dispose closure, and the registry is its sole owner. On
 * shutdown it drains in strict LIFO order (last acquired, first dropped —
 * exactly Rust's Drop order), each dispose bounded by a per-resource timeout so
 * one wedged handle cannot stall the drain. Anything still owned after the drain
 * is logged with its allocation site: an invisible leak becomes a loud, located
 * defect at the one moment you can see the whole inventory.
 */

/** Teardown function. Must be idempotent and should not throw on the happy path. */
export type DisposeFn = () => void | Promise<void>;

export interface ResourceHandle {
  /** Release this resource now and unregister it. Idempotent. */
  dispose(): Promise<void>;
  readonly label: string;
  readonly disposed: boolean;
}

interface Entry {
  readonly id: number;
  readonly label: string;
  readonly dispose: DisposeFn;
  readonly allocatedAt: string;
  disposed: boolean;
  disposing: Promise<void> | null;
}

@Injectable()
export class ResourceRegistry implements OnModuleDestroy {
  private readonly log = new Logger(ResourceRegistry.name);
  private readonly entries = new Map<number, Entry>();
  private seq = 0;
  private shuttingDown = false;
  private readonly perResourceTimeoutMs: number;

  constructor(@Inject(CONFIG) config: AppConfig) {
    this.perResourceTimeoutMs = config.RESOURCE_DISPOSE_TIMEOUT_MS;
  }

  register(label: string, dispose: DisposeFn): ResourceHandle {
    if (this.shuttingDown) {
      // Illegal state: a resource acquired during teardown would never be owned
      // by anyone and never dropped. Fail loud instead of leaking silently.
      throw new Error(`ResourceRegistry: refusing to register "${label}" during shutdown`);
    }
    const id = ++this.seq;
    const entry: Entry = {
      id,
      label,
      dispose,
      allocatedAt: captureSite(),
      disposed: false,
      disposing: null,
    };
    this.entries.set(id, entry);
    return {
      label,
      get disposed() {
        return entry.disposed;
      },
      dispose: () => this.disposeEntry(entry),
    };
  }

  private disposeEntry(entry: Entry): Promise<void> {
    if (entry.disposed) return Promise.resolve();
    if (entry.disposing) return entry.disposing;
    entry.disposing = (async () => {
      try {
        await withTimeout(
          Promise.resolve(entry.dispose()),
          this.perResourceTimeoutMs,
          entry.label,
        );
      } catch (error) {
        this.log.error(
          `dispose failed for "${entry.label}" (allocated at ${entry.allocatedAt})`,
          error instanceof Error ? error.stack : String(error),
        );
      } finally {
        entry.disposed = true;
        this.entries.delete(entry.id);
      }
    })();
    return entry.disposing;
  }

  /** NestJS fires this via app.close(). Drop everything in strict LIFO order. */
  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    const ordered = [...this.entries.values()].sort((a, b) => b.id - a.id);
    if (ordered.length > 0) this.log.log(`draining ${String(ordered.length)} owned resource(s)`);
    for (const entry of ordered) {
      await this.disposeEntry(entry);
    }
    this.tripwire();
  }

  /** Leak tripwire: anything still owned here was allocated but never released. */
  private tripwire(): void {
    if (this.entries.size === 0) return;
    for (const entry of this.entries.values()) {
      this.log.error(
        `LEAK: resource "${entry.label}" not released at shutdown (allocated at ${entry.allocatedAt})`,
      );
    }
    this.log.error(`LEAK TRIPWIRE: ${String(this.entries.size)} resource(s) leaked`);
  }

  /** Live inventory — for a debug endpoint or leak assertions in tests. */
  inventory(): ReadonlyArray<{ label: string; allocatedAt: string }> {
    return [...this.entries.values()].map((e) => ({ label: e.label, allocatedAt: e.allocatedAt }));
  }
}

function captureSite(): string {
  const stack = new Error().stack?.split('\n') ?? [];
  // frame 0 = 'Error', 1 = captureSite, 2 = register, 3 = the real caller.
  return stack[3]?.trim() ?? 'unknown';
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_resolve, reject) => {
      // .unref() so the watchdog timer never keeps the loop alive by itself.
      setTimeout(() => {
        reject(new Error(`dispose timed out after ${String(ms)}ms: ${label}`));
      }, ms).unref();
    }),
  ]);
}
