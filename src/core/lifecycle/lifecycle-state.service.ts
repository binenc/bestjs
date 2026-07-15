import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';

/**
 * LifecycleState — an explicit process state machine so liveness and readiness
 * stay independent signals.
 *
 * Conflating the two probes causes opposite disasters. If they are the same
 * endpoint, then during a drain the liveness probe also fails and the
 * orchestrator RESTARTS the pod mid-drain, killing in-flight requests.
 * Conversely, if a transient downstream (a DB blip) is wired into liveness, one
 * hiccup triggers a restart storm across every replica at once. The probes
 * answer different questions and must be independent.
 *
 *   liveness  = "is the event loop fundamentally healthy?" — stays UP while
 *               draining, because an orderly drain is not a crash. Never depends
 *               on downstreams.
 *   readiness = "should NEW traffic route here?" — fails the instant we enter
 *               draining, so the load balancer pulls the instance before a
 *               single connection is closed.
 *
 * The state flips to `ready` via OnApplicationBootstrap and to `draining`
 * explicitly from the signal handler, making the illegal "serving traffic while
 * tearing down the pool" window unrepresentable.
 */
export type Phase = 'starting' | 'ready' | 'draining';

@Injectable()
export class LifecycleState implements OnApplicationBootstrap {
  private readonly log = new Logger(LifecycleState.name);
  private phase: Phase = 'starting';

  onApplicationBootstrap(): void {
    this.phase = 'ready';
    this.log.log('ready; accepting traffic');
  }

  markDraining(signal: string): void {
    if (this.phase === 'draining') return;
    this.phase = 'draining';
    this.log.warn(`draining (signal=${signal}); readiness now failing`);
  }

  /**
   * Liveness: healthy enough to keep running. TRUE while draining — an orderly
   * drain must not be mistaken for a crash and restarted.
   */
  isLive(): boolean {
    return this.phase !== 'starting';
  }

  /** Readiness: should NEW traffic be routed here? False during drain. */
  isReady(): boolean {
    return this.phase === 'ready';
  }

  get current(): Phase {
    return this.phase;
  }
}
