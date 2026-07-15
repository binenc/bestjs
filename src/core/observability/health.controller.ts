import { Controller, Get, Inject } from '@nestjs/common';
import { CONFIG, type AppConfig } from '../config/env.schema';
import { Errors } from '../errors/app-error';
import { LifecycleState } from '../lifecycle/lifecycle-state.service';

/**
 * Hand-rolled liveness/readiness — no Terminus dependency (smaller supply-chain
 * surface, exact semantics we control). Liveness and readiness are separate
 * endpoints on purpose (see LifecycleState): a drain must fail readiness without
 * failing liveness, so the load balancer removes the instance without the
 * orchestrator restarting it mid-drain.
 */
@Controller('health')
export class HealthController {
  private readonly startedAt = Date.now();

  constructor(
    private readonly lifecycle: LifecycleState,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Liveness: cheap, independent of downstreams, so a transient dependency blip
   * never triggers a cluster-wide restart storm. Stays UP while draining.
   */
  @Get('live')
  live(): { status: 'live'; phase: string; uptimeMs: number } {
    if (!this.lifecycle.isLive()) {
      throw Errors.unavailable('NOT_LIVE', 'process is still starting');
    }
    return { status: 'live', phase: this.lifecycle.current, uptimeMs: Date.now() - this.startedAt };
  }

  /**
   * Readiness: should NEW traffic route here? Fails instantly on drain, and on a
   * breach of the configured RSS ceiling — shedding load before the OOM-killer
   * would otherwise SIGKILL us mid-request.
   */
  @Get('ready')
  ready(): { status: 'ready'; rssBytes: number } {
    if (!this.lifecycle.isReady()) {
      throw Errors.unavailable('DRAINING', `instance is ${this.lifecycle.current}`);
    }
    const { rss } = process.memoryUsage();
    if (this.config.MEM_RSS_CEILING_BYTES > 0 && rss > this.config.MEM_RSS_CEILING_BYTES) {
      throw Errors.unavailable('MEMORY_PRESSURE', 'RSS above configured ceiling', {
        details: { rssBytes: rss, ceilingBytes: this.config.MEM_RSS_CEILING_BYTES },
      });
    }
    return { status: 'ready', rssBytes: rss };
  }
}
