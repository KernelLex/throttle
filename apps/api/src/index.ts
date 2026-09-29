/**
 * Process entry point.
 *
 * ONE CODEBASE, TWO ROLES
 * -----------------------
 * `ROLE=api` serves HTTP. `ROLE=worker` consumes queues. `ROLE=both` does both, which
 * is convenient locally.
 *
 * Splitting them in production is what lets you deploy or restart the API without
 * interrupting in-flight sends, and lets the worker scale on queue depth while the
 * API scales on request rate. It is also what makes `docker compose up --scale
 * worker=3` a genuine test of the multi-instance rate-limiting guarantees rather
 * than a simulation of one.
 *
 * GRACEFUL SHUTDOWN
 * -----------------
 * On SIGTERM the worker stops accepting NEW jobs but finishes what it holds. Killing
 * a worker mid-send would leave rows stuck in SENDING until the reaper frees them —
 * recoverable, but it delays those emails for a full lock TTL for no reason.
 */

// MUST be first: populates process.env before config.ts validates it at import time.
import './loadEnv.js';

import type { Server } from 'node:http';
import type { Worker } from 'bullmq';
import { createApp } from './app.js';
import { env, runsApi, runsWorker } from './config.js';
import { closeDatabase, pingDatabase } from './lib/prisma.js';
import { assertPersistenceEnabled, closeRedis } from './lib/redis.js';
import { logger } from './lib/logger.js';
import { closeQueues } from './queues/index.js';
import { closeAllTransports } from './mailer/transport.js';
import { createEmailWorker } from './scheduler/emailWorker.js';
import {
  createMaintenanceWorker,
  createNotificationWorker,
  createSearchIndexWorker,
} from './scheduler/supportWorkers.js';
import { runStartupRecovery, startMaintenanceChain } from './scheduler/maintenance.js';
import { registerRateLimitScripts } from './scheduler/rateLimiter.js';
import { registerHealthScripts } from './scheduler/senderHealth.js';
import { ensureIndex } from './search/elasticsearch.js';
import { closeElasticsearch } from './search/elasticsearch.js';

const log = logger.child({ component: 'bootstrap' });

let httpServer: Server | undefined;
const workers: Worker[] = [];
let shuttingDown = false;

async function main(): Promise<void> {
  log.info({ role: env.ROLE, nodeEnv: env.NODE_ENV }, 'Starting Throttle');

  // Fail fast if Postgres is unreachable. Without it nothing works, and a process
  // that starts and then 500s on every request is harder to diagnose than one that
  // refuses to start.
  if (!(await pingDatabase())) {
    log.fatal(
      'Cannot reach Postgres. Is it running? Try: npm run infra:up',
    );
    process.exit(1);
  }

  // Warn loudly (but do not exit) if Redis is not persisting. See redis.ts.
  await assertPersistenceEnabled();

  // Load the Lua scripts once at boot rather than lazily on the first send.
  registerRateLimitScripts();
  registerHealthScripts();

  // Best-effort — the app runs fine with search degraded to the Postgres fallback.
  await ensureIndex();

  if (runsWorker) {
    // BEFORE consuming anything: reap abandoned claims and re-enqueue anything
    // Postgres knows about but Redis does not. This is what makes the restart demo
    // work — see maintenance.ts for the three failure modes it covers.
    await runStartupRecovery();

    workers.push(createEmailWorker());
    workers.push(createMaintenanceWorker());
    workers.push(createSearchIndexWorker());
    workers.push(createNotificationWorker());

    await startMaintenanceChain();

    log.info({ workers: workers.length }, 'Workers running');
  }

  if (runsApi) {
    httpServer = createApp().listen(env.API_PORT, () => {
      log.info(
        {
          port: env.API_PORT,
          apiBaseUrl: env.API_BASE_URL,
          webBaseUrl: env.WEB_BASE_URL,
          bullBoard: `${env.API_BASE_URL}/admin/queues`,
        },
        'API listening',
      );
    });
  }
}

/**
 * Shut down in dependency order: stop new work, drain in-flight work, then close
 * connections. Closing Redis before the workers drain would fail the very jobs we
 * are trying to let finish.
 */
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  log.info({ signal }, 'Shutting down gracefully…');

  // Hard deadline. If a send is genuinely wedged, exiting is better than hanging —
  // the reaper will recover the row on the next boot.
  const forceExit = setTimeout(() => {
    log.error('Graceful shutdown timed out after 30s — forcing exit');
    process.exit(1);
  }, 30_000);
  forceExit.unref();

  try {
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
      log.info('HTTP server closed');
    }

    // `close()` waits for in-flight jobs to finish before resolving.
    await Promise.all(workers.map((worker) => worker.close()));
    if (workers.length > 0) log.info('Workers drained');

    closeAllTransports();
    await closeQueues();
    await closeElasticsearch();
    await closeDatabase();
    await closeRedis();

    clearTimeout(forceExit);
    log.info('Shutdown complete');
    process.exit(0);
  } catch (err) {
    log.error({ err }, 'Error during shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// A rejection that reaches here is a bug. Log it with full context and exit so the
// supervisor restarts into a known-good state, rather than continuing in a state we
// have not reasoned about.
process.on('unhandledRejection', (reason) => {
  log.fatal({ reason }, 'Unhandled promise rejection');
  void shutdown('unhandledRejection');
});

process.on('uncaughtException', (err) => {
  log.fatal({ err }, 'Uncaught exception');
  void shutdown('uncaughtException');
});

main().catch((err) => {
  log.fatal({ err }, 'Failed to start');
  process.exit(1);
});
