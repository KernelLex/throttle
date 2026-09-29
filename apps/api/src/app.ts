/**
 * Express application assembly.
 *
 * MIDDLEWARE ORDER IS SECURITY-RELEVANT
 * -------------------------------------
 * The order below is not stylistic. In particular:
 *   - helmet before routes, so headers are set even on error responses
 *   - CORS before anything that reads the body, so a rejected origin never reaches
 *     application code
 *   - cookieParser before CSRF and auth, both of which read cookies
 *   - the body limit before JSON parsing, so an oversized payload is rejected before
 *     it is buffered
 *   - the error handler LAST, or Express does not treat it as an error handler
 */

import express, { type Express, type Request, type Response } from 'express';
import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { pinoHttp } from 'pino-http';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import type { ApiResponse } from '@throttle/core';
import { env, googleOAuthEnabled, isProduction, slackOAuthEnabled } from './config.js';
import { logger } from './lib/logger.js';
import { pingDatabase } from './lib/prisma.js';
import { pingRedis, redis } from './lib/redis.js';
import { pingElasticsearch } from './search/elasticsearch.js';
import { allQueues } from './queues/index.js';
import { requireAuth, requireRole } from './middleware/auth.js';
import { issueCsrfToken, verifyCsrf } from './middleware/csrf.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { authRouter } from './routes/auth.js';
import { campaignsRouter } from './routes/campaigns.js';
import { emailsRouter } from './routes/emails.js';
import { leadsRouter } from './routes/leads.js';
import { sendersRouter } from './routes/senders.js';
import { slackRouter } from './routes/slack.js';
import { statsRouter } from './routes/stats.js';

export function createApp(): Express {
  const app = express();

  // Behind a reverse proxy, req.ip must come from X-Forwarded-For or every client
  // shares one IP and per-IP rate limiting becomes global rate limiting.
  // `1` (not `true`) trusts exactly one hop — trusting all hops lets a client spoof
  // its own IP by sending the header itself.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // ── Request id ─────────────────────────────────────────────────────────────
  app.use((req, _res, next) => {
    req.requestId = randomUUID();
    next();
  });

  app.use(
    pinoHttp({
      logger,
      genReqId: (req: IncomingMessage) => (req as Request).requestId ?? randomUUID(),
      // Health probes would otherwise dominate the log at one line per second.
      autoLogging: {
        ignore: (req: IncomingMessage) => req.url === '/healthz' || req.url === '/readyz',
      },
    }),
  );

  // ── Security headers ───────────────────────────────────────────────────────
  app.use(
    helmet({
      contentSecurityPolicy: isProduction
        ? {
            directives: {
              defaultSrc: ["'self'"],
              scriptSrc: ["'self'"],
              styleSrc: ["'self'", "'unsafe-inline'"],
              imgSrc: ["'self'", 'data:', 'https:'],
              connectSrc: ["'self'"],
              frameAncestors: ["'none'"],
              objectSrc: ["'none'"],
            },
          }
        : // Disabled in dev because Bull Board's bundled UI uses inline scripts that
          // a strict CSP blocks. It is enabled in production, where the API serves
          // no HTML of its own.
          false,
      crossOriginEmbedderPolicy: false,
      hsts: isProduction ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    }),
  );

  // ── CORS ───────────────────────────────────────────────────────────────────
  app.use(
    cors({
      origin(origin, callback) {
        // No Origin header: same-origin, curl, or a server-to-server call. Allowed,
        // because CORS is a browser protection and these are not browser requests.
        if (!origin) {
          callback(null, true);
          return;
        }

        if (env.CORS_ALLOWED_ORIGINS.includes(origin)) {
          callback(null, true);
          return;
        }

        // Log and reject. There is deliberately no wildcard fallback: `origin: true`
        // with `credentials: true` would let ANY site make authenticated requests.
        logger.warn({ origin }, 'Blocked request from disallowed origin');
        callback(new Error('Origin not allowed'));
      },
      // Required for the httpOnly session cookies to be sent cross-origin.
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'Idempotency-Key', 'Authorization'],
      maxAge: 86_400,
    }),
  );

  // ── Body parsing ───────────────────────────────────────────────────────────
  // A campaign with 50,000 recipients is a legitimately large JSON body; multipart
  // uploads are bounded separately by multer.
  app.use(express.json({ limit: '25mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(cookieParser(env.COOKIE_SECRET));

  // ── Rate limiting ──────────────────────────────────────────────────────────
  // Redis-backed so the budget is shared across API instances. An in-memory store
  // would give each instance its own allowance, multiplying the real limit by the
  // instance count.
  const makeLimiter = (max: number, windowMs: number, prefix: string) =>
    rateLimit({
      windowMs,
      max,
      standardHeaders: true,
      legacyHeaders: false,
      store: new RedisStore({
        sendCommand: (...args: string[]) => redis.call(...(args as [string, ...string[]])) as never,
        prefix: `throttle:ratelimit:${prefix}:`,
      }),
      handler: (_req, res) => {
        const body: ApiResponse<never> = {
          ok: false,
          error: { code: 'RATE_LIMITED', message: 'Too many requests. Please slow down.' },
        };
        res.status(429).json(body);
      },
    });

  // Auth endpoints get a far tighter budget — they are the brute-force target.
  app.use(
    '/api/auth',
    makeLimiter(env.AUTH_RATE_LIMIT_MAX_REQUESTS, env.RATE_LIMIT_WINDOW_MS, 'auth'),
  );
  app.use('/api', makeLimiter(env.RATE_LIMIT_MAX_REQUESTS, env.RATE_LIMIT_WINDOW_MS, 'api'));

  // ── CSRF ───────────────────────────────────────────────────────────────────
  app.use(issueCsrfToken);
  app.use('/api', verifyCsrf);

  // ── Health probes (public — no tenant data) ────────────────────────────────
  app.get('/healthz', (_req: Request, res: Response) => {
    res.json({ status: 'ok', role: env.ROLE, uptime: process.uptime() });
  });

  app.get('/readyz', async (_req: Request, res: Response) => {
    const [postgres, redisOk, elasticsearch] = await Promise.all([
      pingDatabase(),
      pingRedis(),
      pingElasticsearch(),
    ]);

    // Elasticsearch is deliberately NOT part of readiness unless explicitly required:
    // search being degraded must not take the whole service out of a load balancer.
    const ready = postgres && redisOk && (!env.ELASTICSEARCH_REQUIRED || elasticsearch);

    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'not_ready',
      postgres: postgres ? 'ok' : 'down',
      redis: redisOk ? 'ok' : 'down',
      elasticsearch: elasticsearch ? 'ok' : 'down',
      elasticsearchRequired: env.ELASTICSEARCH_REQUIRED,
    });
  });

  /** Public, secret-free: tells the frontend which login options to render. */
  app.get('/api/config', (_req: Request, res: Response) => {
    const body: ApiResponse<{ googleOAuthEnabled: boolean; slackOAuthEnabled: boolean }> = {
      ok: true,
      data: { googleOAuthEnabled, slackOAuthEnabled },
    };
    res.json(body);
  });

  // ── API routes ─────────────────────────────────────────────────────────────
  app.use('/api/auth', authRouter);
  app.use('/api/campaigns', campaignsRouter);
  app.use('/api/emails', emailsRouter);
  app.use('/api/senders', sendersRouter);
  app.use('/api/slack', slackRouter);
  app.use('/api/leads', leadsRouter);
  app.use('/api/stats', statsRouter);

  // ── Bull Board ─────────────────────────────────────────────────────────────
  //
  // The brief asks for a "live BullMQ dashboard". This is the endpoint that is
  // most often left wide open — it exposes job payloads (recipient addresses,
  // tenant ids) and lets anyone retry or delete jobs.
  //
  // Here it sits behind requireAuth AND, by default, requireRole('ADMIN').
  // BULL_BOARD_REQUIRE_ADMIN defaults to TRUE when unset, so forgetting to set it
  // fails closed rather than open.
  const bullBoardAdapter = new ExpressAdapter();
  bullBoardAdapter.setBasePath('/admin/queues');

  createBullBoard({
    queues: allQueues.map((queue) => new BullMQAdapter(queue)),
    serverAdapter: bullBoardAdapter,
    options: {
      uiConfig: {
        boardTitle: 'Throttle Queues',
      },
    },
  });

  const bullBoardGuards = env.BULL_BOARD_REQUIRE_ADMIN
    ? [requireAuth, requireRole('ADMIN')]
    : [requireAuth];

  app.use('/admin/queues', ...bullBoardGuards, bullBoardAdapter.getRouter());

  // ── Terminal handlers ──────────────────────────────────────────────────────
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
