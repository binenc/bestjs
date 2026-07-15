import 'reflect-metadata';
import type { Server } from 'node:http';
import { NestFactory, PartialGraphHost } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import { Logger as PinoLogger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { assertNoDependencyCycles } from './core/bootstrap/dependency-cycle';
import { withBootDeadline } from './core/bootstrap/boot-deadline';
import { BootProgressLogger } from './core/bootstrap/boot-progress.logger';
import { installFatalGuards } from './core/bootstrap/process-guards';
import { config } from './core/config/env.schema';
import { canonicalUrlMiddleware } from './core/http/canonical-url.middleware';
import { idleTimeoutMiddleware } from './core/http/request-limits';
import { LifecycleState } from './core/lifecycle/lifecycle-state.service';

/**
 * main.ts encodes the bootstrap as a strict linear pipeline where each stage is
 * a precondition for the next. Importing `config` on line one already validated
 * the environment (or exited 78) before anything else runs. Nothing binds a port
 * until every prior gate has passed.
 */

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

async function bootstrap(): Promise<void> {
  // Gate 1: from here on, any unhandled fault is fatal, not survivable.
  installFatalGuards();

  // Gate 2: prove the DI graph is acyclic BEFORE Nest tries to build it. Pure
  //         static analysis — it cannot itself hang.
  assertNoDependencyCycles(AppModule);

  // Gate 3: build under a hard deadline. A DI graph that cannot resolve within
  //         BOOTSTRAP_TIMEOUT_MS is treated as permanently broken, not "slow".
  const bootLogger = new BootProgressLogger();
  const app = await withBootDeadline(
    'NestFactory.create',
    () =>
      NestFactory.create<NestExpressApplication>(AppModule, {
        logger: bootLogger,
        abortOnError: false, // reject into our watchdog instead of an opaque process.exit(1)
        snapshot: true, // capture the partial graph so a timeout is diagnosable
        bodyParser: false, // we own the byte caps explicitly below
      }),
    {
      deadlineMs: config.BOOTSTRAP_TIMEOUT_MS,
      diagnose: () =>
        [
          `last init activity: ${bootLogger.lastActivity}`,
          'partial construction graph:',
          PartialGraphHost.toString() ?? '<none captured>',
        ].join('\n'),
    },
  );

  // Route framework + application logs through structured pino.
  app.useLogger(app.get(PinoLogger));
  if (config.TRUST_PROXY) app.set('trust proxy', 1);

  // Middleware order is load-bearing: canonicalize the URL FIRST so every guard
  // sees one canonical path, then bound the socket, then parse bodies under an
  // explicit byte cap.
  app.use(canonicalUrlMiddleware);
  app.use(idleTimeoutMiddleware(config.REQUEST_TIMEOUT_MS));
  app.use(express.json({ limit: config.BODY_LIMIT_BYTES }));
  app.use(express.urlencoded({ extended: false, limit: config.BODY_LIMIT_BYTES }));

  // Enable the shutdown-hook machinery (so app.close() fires the lifecycle graph)
  // but pass NO signals — we orchestrate the ordering ourselves below.
  app.enableShutdownHooks([]);

  const server = app.getHttpServer() as Server;
  server.requestTimeout = config.REQUEST_TIMEOUT_MS; // whole-request receive window
  server.headersTimeout = config.HEADERS_TIMEOUT_MS; // header-receive (slowloris on headers)
  server.keepAliveTimeout = config.KEEPALIVE_TIMEOUT_MS; // idle keep-alive window

  // Deterministic graceful shutdown under a hard wall-clock budget.
  const lifecycle = app.get(LifecycleState);
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    const deadline = setTimeout(() => {
      bootLogger.error(`shutdown exceeded ${String(config.SHUTDOWN_DEADLINE_MS)}ms; forcing exit(1)`);
      process.exit(1);
    }, config.SHUTDOWN_DEADLINE_MS);
    deadline.unref();
    try {
      lifecycle.markDraining(signal); // 1. leave rotation — readiness fails immediately
      await delay(config.SHUTDOWN_GRACE_MS); // 2. let the LB observe the failing probe
      await app.close(); // 3. LIFO drain via the ResourceRegistry
      bootLogger.log('graceful shutdown complete', 'Bootstrap');
      process.exit(0);
    } catch (error) {
      bootLogger.error('error during shutdown', error instanceof Error ? error.stack : String(error));
      process.exit(1);
    }
  };
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => void shutdown(sig));
  }

  await app.listen(config.PORT, config.HOST);
  bootLogger.log(`bestjs listening on ${config.HOST}:${String(config.PORT)} [${config.NODE_ENV}]`, 'Bootstrap');
}

// A rejection here becomes an unhandledRejection -> installFatalGuards() -> exit(1).
void bootstrap();
