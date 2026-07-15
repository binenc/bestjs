import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Params } from 'nestjs-pino';
import { config } from '../config/env.schema';

/**
 * Structured JSON logging via pino (pure JS — no native addon, Bun-friendly).
 *
 * Deliberately NO pino-pretty transport: prettifying runs in a worker thread,
 * which is an extra dependency and a historical Bun rough edge. Emit JSON in
 * every environment and pipe through `pino-pretty` at the shell for local dev
 * if you want colors. Sensitive headers are redacted at the source so secrets
 * never reach a log sink. Every request gets a stable correlation id echoed back
 * in the `x-request-id` response header.
 */
export const loggerConfig: Params = {
  pinoHttp: {
    level: config.LOG_LEVEL,
    autoLogging: true,
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["set-cookie"]'],
      remove: true,
    },
    genReqId: (req: IncomingMessage, res: ServerResponse): string => {
      const existing = req.headers['x-request-id'];
      const id = typeof existing === 'string' && existing.length > 0 ? existing : crypto.randomUUID();
      res.setHeader('x-request-id', id);
      return id;
    },
  },
};
