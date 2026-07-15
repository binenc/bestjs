import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { MemoryWatermarkService } from './memory-watermark.service';

/**
 * Health endpoints + memory watermarking. Structured logging is wired at the
 * application root (LoggerModule.forRoot in AppModule) so the pino logger is
 * global; this module carries the rest of the observability floor.
 */
@Module({
  controllers: [HealthController],
  providers: [MemoryWatermarkService],
})
export class ObservabilityModule {}
