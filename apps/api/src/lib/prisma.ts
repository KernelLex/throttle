/**
 * Prisma client singleton.
 *
 * The `globalThis` cache exists for `tsx watch`: without it, every hot reload opens a
 * fresh connection pool and the old one is never drained, so after a dozen edits you
 * hit Postgres's `max_connections` and get errors that look like a database problem
 * but are really a dev-server problem.
 */

import { PrismaClient } from '@prisma/client';
import { env, isProduction } from '../config.js';
import { createLogger } from './logger.js';

const log = createLogger('prisma');

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    datasources: { db: { url: env.DATABASE_URL } },
    log: isProduction
      ? [{ emit: 'event', level: 'error' }]
      : [
          { emit: 'event', level: 'error' },
          { emit: 'event', level: 'warn' },
        ],
  });

prisma.$on('error' as never, (event: unknown) => {
  log.error({ event }, 'Prisma error');
});

if (!isProduction) {
  globalForPrisma.prisma = prisma;
}

/** Readiness probe support. */
export async function pingDatabase(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (err) {
    log.error({ err }, 'Database ping failed');
    return false;
  }
}

export async function closeDatabase(): Promise<void> {
  await prisma.$disconnect();
  log.info('Database disconnected');
}
