/**
 * Redis connections.
 *
 * THREE SEPARATE CONNECTIONS, ON PURPOSE
 * --------------------------------------
 * 1. `redis`          — general commands (rate limiting, health, OAuth state)
 * 2. `bullConnection` — BullMQ queues and workers
 * 3. `subscriber`     — blocking/subscribe operations
 *
 * They are separate because BullMQ workers issue BLOCKING commands (BRPOPLPUSH) that
 * occupy a connection for seconds at a time. Sharing one connection would mean a
 * rate-limit check could sit behind a blocked worker read, adding seconds of latency
 * to every send — a bug that only appears under load and looks like "Redis is slow".
 *
 * `maxRetriesPerRequest: null` is REQUIRED by BullMQ; it throws at startup otherwise.
 */

import { Redis, type RedisOptions } from 'ioredis';
import { env } from '../config.js';
import { createLogger } from './logger.js';

const log = createLogger('redis');

const baseOptions: RedisOptions = {
  // Keep retrying rather than giving up: a scheduler that permanently detaches from
  // Redis after a brief blip has effectively lost its schedule.
  retryStrategy(times) {
    const delayMs = Math.min(times * 200, 5_000);
    log.warn({ attempt: times, delayMs }, 'Redis connection lost — retrying');
    return delayMs;
  },
  // Queue commands issued while reconnecting instead of failing them outright.
  enableOfflineQueue: true,
  connectTimeout: 10_000,
};

/** General-purpose client. */
export const redis = new Redis(env.REDIS_URL, baseOptions);

/**
 * BullMQ's connection.
 *
 * `maxRetriesPerRequest: null` is mandatory — BullMQ refuses to start without it,
 * because its blocking reads legitimately exceed any finite retry budget.
 */
export const bullConnection = new Redis(env.REDIS_URL, {
  ...baseOptions,
  maxRetriesPerRequest: null,
});

/** Dedicated connection for blocking/subscribe work. */
export const subscriber = new Redis(env.REDIS_URL, {
  ...baseOptions,
  maxRetriesPerRequest: null,
});

const connections = [
  { name: 'general', client: redis },
  { name: 'bullmq', client: bullConnection },
  { name: 'subscriber', client: subscriber },
] as const;

for (const { name, client } of connections) {
  client.on('connect', () => log.debug({ connection: name }, 'Redis connecting'));
  client.on('ready', () => log.info({ connection: name }, 'Redis ready'));
  client.on('error', (err) => log.error({ connection: name, err: err.message }, 'Redis error'));
  client.on('close', () => log.warn({ connection: name }, 'Redis connection closed'));
}

/** Readiness probe support. */
export async function pingRedis(): Promise<boolean> {
  try {
    return (await redis.ping()) === 'PONG';
  } catch {
    return false;
  }
}

/**
 * Verify AOF persistence is actually on.
 *
 * Called at boot and logged loudly if it is not, because the failure mode is silent:
 * everything works perfectly until a hard restart, at which point recently scheduled
 * jobs are simply gone. Better to be told at startup than during the demo.
 */
export async function assertPersistenceEnabled(): Promise<void> {
  try {
    const result = await redis.config('GET', 'appendonly');
    const enabled = Array.isArray(result) && result[1] === 'yes';

    if (!enabled) {
      log.warn(
        { appendonly: Array.isArray(result) ? result[1] : 'unknown' },
        'Redis AOF persistence is DISABLED. Delayed jobs may be lost on a hard restart. ' +
          'Start Redis with `--appendonly yes` (docker-compose.yml already does this). ' +
          'The startup reconciler will recover jobs from Postgres, but sends may be late.',
      );
    } else {
      log.info('Redis AOF persistence enabled');
    }
  } catch (err) {
    // Managed Redis providers often block CONFIG GET. Not fatal — just unverifiable.
    log.debug({ err }, 'Could not verify Redis persistence (CONFIG GET may be disabled)');
  }
}

export async function closeRedis(): Promise<void> {
  await Promise.allSettled(connections.map(({ client }) => client.quit()));
  log.info('Redis connections closed');
}
