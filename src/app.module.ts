import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { ConfigModule, config } from './core/config/config.module';
import { AllExceptionsFilter } from './core/errors/all-exceptions.filter';
import { PathPrefixAuthGuard } from './core/http/path-prefix-auth.guard';
import { RequestTimeoutInterceptor } from './core/http/request-limits';
import { LifecycleModule } from './core/lifecycle/lifecycle.module';
import { loggerConfig } from './core/observability/logger.config';
import { ObservabilityModule } from './core/observability/observability.module';
import { DemoModule } from './modules/demo/demo.module';
import { TodosModule } from './modules/todos/todos.module';

/**
 * Composition root. The three cross-cutting concerns are registered globally so
 * they cannot be forgotten on a route:
 *   - APP_FILTER: the single error→response funnel (handles guard, pipe,
 *     controller, and service failures alike — the fix for "guards run before
 *     interceptors").
 *   - APP_GUARD: bypass-proof path-prefix authorization (reads the canonical URL).
 *   - APP_INTERCEPTOR: the per-handler time budget.
 */
@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRoot(loggerConfig),
    LifecycleModule,
    ObservabilityModule,
    DemoModule,
    TodosModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: PathPrefixAuthGuard },
    {
      provide: APP_INTERCEPTOR,
      useFactory: () => new RequestTimeoutInterceptor(config.HANDLER_TIMEOUT_MS),
    },
  ],
})
export class AppModule {}
