import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { CONFIG, type AppConfig } from '../config/env.schema';
import { Managed } from '../lifecycle/managed';

/**
 * Periodically samples process memory and logs high-water marks. This is the
 * operational counterweight to the (real, if over-hyped) risk of RSS growth in
 * long-running JavaScriptCore processes: you see the trend and get an alertable
 * line the moment RSS crosses a configured ceiling, instead of discovering the
 * leak when the OOM-killer fires.
 *
 * The sampling timer is created via `Managed`, so it is owned by the
 * ResourceRegistry and torn down deterministically on shutdown — the monitor
 * itself cannot leak.
 */
@Injectable()
export class MemoryWatermarkService implements OnApplicationBootstrap {
  private readonly log = new Logger('Memory');
  private rssHighWaterMark = 0;

  constructor(
    private readonly managed: Managed,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    this.managed.setInterval('memory-watermark', this.config.MEM_WATERMARK_INTERVAL_MS, () => {
      this.sample();
    });
    this.sample();
  }

  private sample(): void {
    const mem = process.memoryUsage();
    const isNewPeak = mem.rss > this.rssHighWaterMark;
    if (isNewPeak) this.rssHighWaterMark = mem.rss;

    const fields = {
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      heapTotalBytes: mem.heapTotal,
      externalBytes: mem.external,
      rssHighWaterMarkBytes: this.rssHighWaterMark,
    };
    const ceiling = this.config.MEM_RSS_CEILING_BYTES;

    if (ceiling > 0 && mem.rss > ceiling) {
      this.log.error(`RSS above ceiling (${String(ceiling)}B) ${JSON.stringify(fields)}`);
    } else if (isNewPeak) {
      this.log.log(`new RSS high-water mark ${JSON.stringify(fields)}`);
    } else {
      this.log.debug(`memory sample ${JSON.stringify(fields)}`);
    }
  }
}
