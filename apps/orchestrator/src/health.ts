/**
 * The local health and status API.
 *
 * Bound to 127.0.0.1 by default and deliberately read-only: it exists so an
 * operator (or a supervisor script) can see what the process believes without
 * opening a database, and so `verify-all` can assert on live state. It exposes
 * no control surface — a control command that can change trading has to come
 * through the audited path, not through an HTTP POST.
 *
 * `/health` is a liveness probe: it answers as long as the event loop is
 * turning. `/status` is the same snapshot the Lark report is built from.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import type { OrchestratorScheduler } from './scheduler.js';

export interface HealthServerOptions {
  config: Config;
  logger: Logger;
  scheduler: OrchestratorScheduler;
}

export interface HealthServer {
  app: FastifyInstance;
  start(): Promise<string>;
  stop(): Promise<void>;
}

export function createHealthServer(options: HealthServerOptions): HealthServer {
  const { config, logger, scheduler } = options;
  const app = Fastify({ logger: false, disableRequestLogging: true });

  app.get('/health', async () => ({
    ok: true,
    at: new Date().toISOString(),
    tick: scheduler.tickNumber,
  }));

  app.get('/status', async () => scheduler.status());

  /**
   * The report content, for an operator who wants to see exactly what the next
   * scheduled Lark message will contain without waiting for its window.
   */
  app.get('/report.json', async () => scheduler.buildReport());

  return {
    app,
    async start(): Promise<string> {
      await app.listen({ host: config.health.host, port: config.health.port });
      const address = `http://${config.health.host}:${config.health.port}`;
      logger.event({
        level: 'info',
        source: 'health',
        code: 'health_listening',
        message: `health API listening on ${address}`,
        data: { host: config.health.host, port: config.health.port },
      });
      return address;
    },
    async stop(): Promise<void> {
      await app.close();
    },
  };
}
