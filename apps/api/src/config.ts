/**
 * Environment configuration.
 *
 * FAIL-FAST PHILOSOPHY
 * --------------------
 * Every variable is validated here at import time. A missing or malformed value
 * throws and the process dies before it can accept a single request.
 *
 * This matters more than usual for a scheduler. If `MAX_EMAILS_PER_HOUR_PER_SENDER`
 * silently defaulted to some built-in number because of a typo in `.env`, the system
 * would keep running and keep sending — just at the wrong rate, in a way nobody
 * notices until a provider starts blocking the domain. A crash at boot is
 * dramatically cheaper than that.
 *
 * Secrets additionally get a "did you actually change this?" check in production,
 * because a placeholder secret that boots successfully is a live vulnerability.
 */

import { z } from 'zod';

// ── Coercion helpers ──────────────────────────────────────────────────────────

/** Env vars are always strings; this parses "5000" into 5000 with bounds. */
const intFromEnv = (min: number, max: number) =>
  z.coerce.number().int().min(min).max(max);

/** Accepts "true"/"1"/"yes" in any case. Anything else is false. */
const boolFromEnv = z
  .string()
  .optional()
  .transform((v) => /^(true|1|yes)$/i.test(v ?? ''));

/** Comma-separated list → trimmed, non-empty array. */
const csvFromEnv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

/** Placeholder values shipped in .env.example. Refused in production. */
const PLACEHOLDER_PATTERN = /^change_me/i;

const secretSchema = (minLength: number) =>
  z
    .string()
    .min(minLength, `Must be at least ${minLength} characters`)
    .refine((v) => !(process.env['NODE_ENV'] === 'production' && PLACEHOLDER_PATTERN.test(v)), {
      message:
        'Still set to the .env.example placeholder. Generate a real secret with `openssl rand -hex 32`.',
    });

// ── Schema ────────────────────────────────────────────────────────────────────

const envSchema = z
  .object({
    // Runtime
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    ROLE: z.enum(['api', 'worker', 'both']).default('both'),
    API_PORT: intFromEnv(1, 65535).default(4000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    API_BASE_URL: z.string().url(),
    WEB_BASE_URL: z.string().url(),

    // Datastores
    DATABASE_URL: z.string().url().startsWith('postgres'),
    REDIS_URL: z.string().url().startsWith('redis'),
    ELASTICSEARCH_URL: z.string().url(),
    ELASTICSEARCH_INDEX: z.string().min(1).default('throttle-emails'),
    ELASTICSEARCH_REQUIRED: boolFromEnv,

    // Secrets
    JWT_ACCESS_SECRET: secretSchema(32),
    JWT_REFRESH_SECRET: secretSchema(32),
    COOKIE_SECRET: secretSchema(16),
    // Exactly 32 bytes, hex-encoded, for AES-256-GCM. Validated strictly because a
    // wrong-length key fails at first use (mid-send) rather than at boot.
    ENCRYPTION_KEY: z
      .string()
      .regex(/^[0-9a-f]{64}$/i, 'Must be exactly 64 hexadecimal characters (32 bytes)')
      .refine((v) => !(process.env['NODE_ENV'] === 'production' && PLACEHOLDER_PATTERN.test(v)), {
        message: 'Still set to the .env.example placeholder.',
      }),
    JWT_ACCESS_TTL: z.string().default('15m'),
    JWT_REFRESH_TTL: z.string().default('7d'),

    // Google OAuth
    GOOGLE_CLIENT_ID: z.string().default(''),
    GOOGLE_CLIENT_SECRET: z.string().default(''),
    GOOGLE_ALLOWED_HOSTED_DOMAIN: z.string().default(''),

    // Slack OAuth
    SLACK_CLIENT_ID: z.string().default(''),
    SLACK_CLIENT_SECRET: z.string().default(''),
    SLACK_SIGNING_SECRET: z.string().default(''),

    // ── Scheduler tuning (the brief's "must be configurable" values) ────────
    WORKER_CONCURRENCY: intFromEnv(1, 1000).default(5),
    MIN_DELAY_BETWEEN_EMAILS_MS: intFromEnv(0, 3_600_000).default(2_000),
    MAX_EMAILS_PER_HOUR_PER_SENDER: intFromEnv(1, 100_000).default(200),
    // 0 disables the tenant-wide ceiling and relies on per-sender limits alone.
    MAX_EMAILS_PER_HOUR_GLOBAL: intFromEnv(0, 10_000_000).default(0),

    MAX_SEND_ATTEMPTS: intFromEnv(1, 20).default(3),
    RETRY_BACKOFF_MS: intFromEnv(1_000, 3_600_000).default(30_000),
    JOB_LOCK_TTL_MS: intFromEnv(10_000, 3_600_000).default(120_000),
    RECONCILE_INTERVAL_MS: intFromEnv(10_000, 3_600_000).default(60_000),

    // Circuit breaker
    CIRCUIT_FAILURE_THRESHOLD: intFromEnv(1, 100).default(5),
    CIRCUIT_COOLDOWN_MS: intFromEnv(1_000, 86_400_000).default(300_000),
    CIRCUIT_SUCCESS_THRESHOLD: intFromEnv(1, 100).default(2),
    CIRCUIT_ROLLING_WINDOW: intFromEnv(10, 1_000).default(50),

    // SMTP
    SMTP_AUTO_PROVISION_COUNT: intFromEnv(0, 20).default(3),
    SMTP_POOL_MAX_CONNECTIONS: intFromEnv(1, 100).default(5),
    SMTP_CONNECTION_TIMEOUT_MS: intFromEnv(1_000, 120_000).default(15_000),

    // Security
    CORS_ALLOWED_ORIGINS: csvFromEnv,
    RATE_LIMIT_WINDOW_MS: intFromEnv(1_000, 3_600_000).default(60_000),
    RATE_LIMIT_MAX_REQUESTS: intFromEnv(1, 100_000).default(300),
    AUTH_RATE_LIMIT_MAX_REQUESTS: intFromEnv(1, 10_000).default(10),
    MAX_UPLOAD_BYTES: intFromEnv(1_024, 104_857_600).default(10_485_760),
    BULL_BOARD_REQUIRE_ADMIN: z
      .string()
      .optional()
      // Defaults to TRUE when unset. An unset security flag must fail closed —
      // this is the difference between a private queue dashboard and a public one.
      .transform((v) => (v === undefined || v === '' ? true : !/^(false|0|no)$/i.test(v))),

    /**
     * SameSite policy for session cookies.
     *
     * 'lax' (default) is correct when the browser only ever talks to ONE origin —
     * either local dev, or a deployment where the frontend proxies /api to the
     * backend (see DEPLOYMENT.md). It is the safer setting and should be preferred.
     *
     * 'none' is required when the frontend and API are on genuinely different sites
     * (e.g. app.vercel.app calling api.onrender.com). Browsers refuse to send a Lax
     * cookie on a cross-site fetch, so the user appears permanently signed out —
     * a failure that looks like a broken session rather than a config mistake.
     *
     * 'none' REQUIRES Secure, which requires HTTPS. Validated below.
     * With 'none', CSRF protection rests entirely on the double-submit token, which
     * is why that token is not optional.
     */
    COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  })
  .superRefine((env, ctx) => {
    // Cross-field rules that individual field schemas cannot express.

    if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_REFRESH_SECRET'],
        message:
          'Access and refresh secrets must differ. Sharing one lets an access token be ' +
          'replayed as a refresh token, defeating short access-token lifetimes entirely.',
      });
    }

    if (env.NODE_ENV === 'production') {
      if (env.CORS_ALLOWED_ORIGINS.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['CORS_ALLOWED_ORIGINS'],
          message: 'Must list at least one origin in production. There is no wildcard mode.',
        });
      }
      if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['GOOGLE_CLIENT_ID'],
          message: 'Google OAuth credentials are required in production — login is mandatory.',
        });
      }
      if (!env.API_BASE_URL.startsWith('https://')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['API_BASE_URL'],
          message: 'Must be HTTPS in production — session cookies are set Secure.',
        });
      }
    }

    // SameSite=None is meaningless — and rejected by browsers — without Secure,
    // which we only set in production. Catching it here turns a silent
    // "nobody can stay signed in" into a startup error that names the cause.
    if (env.COOKIE_SAMESITE === 'none' && env.NODE_ENV !== 'production') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['COOKIE_SAMESITE'],
        message:
          "SameSite=None requires Secure cookies, which are only set when NODE_ENV=production. " +
          'Use lax for local development.',
      });
    }

    // A min-gap wider than an hour means a sender can never complete a single
    // window, which would make every plan infinite. Catch it here, not at runtime.
    if (env.MIN_DELAY_BETWEEN_EMAILS_MS >= 3_600_000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MIN_DELAY_BETWEEN_EMAILS_MS'],
        message: 'Must be under one hour, or no sender can complete an hour window.',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    // Printed rather than thrown as a stack trace, because the person reading this
    // is usually setting the project up for the first time and needs a checklist,
    // not a Zod dump.
    const issues = parsed.error.issues
      .map((issue) => `  ✗ ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');

    console.error(
      `\n─────────────────────────────────────────────────────────────\n` +
        `  Throttle cannot start: invalid environment configuration\n` +
        `─────────────────────────────────────────────────────────────\n` +
        `${issues}\n\n` +
        `  Fix: copy .env.example to .env and fill in the values above.\n` +
        `       cp .env.example .env\n` +
        `─────────────────────────────────────────────────────────────\n`,
    );
    process.exit(1);
  }

  return parsed.data;
}

export const env = loadEnv();

// ── Derived config ────────────────────────────────────────────────────────────

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

export const runsApi = env.ROLE === 'api' || env.ROLE === 'both';
export const runsWorker = env.ROLE === 'worker' || env.ROLE === 'both';

/** Google login is only offered when credentials are actually present. */
export const googleOAuthEnabled = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

/** Slack connect is only offered when credentials are actually present. The app must
 *  run fine without it — rate-limit hits simply skip notification. */
export const slackOAuthEnabled = Boolean(env.SLACK_CLIENT_ID && env.SLACK_CLIENT_SECRET);

export const googleRedirectUri = `${env.API_BASE_URL}/api/auth/google/callback`;
export const slackRedirectUri = `${env.API_BASE_URL}/api/slack/callback`;

/**
 * Cookie options shared by the access and refresh cookies.
 *
 * `sameSite` defaults to 'lax' and should stay there whenever possible.
 *
 * Not 'strict', deliberately: the Google OAuth callback is a top-level cross-site
 * navigation back to our domain, and 'strict' would withhold the cookie on that
 * first request — breaking login in a way that looks like a random redirect loop.
 *
 * Set COOKIE_SAMESITE=none only for a split-domain deployment where the frontend
 * cannot proxy to the API. See DEPLOYMENT.md.
 */
export const cookieOptions = {
  httpOnly: true,
  // SameSite=None is invalid without Secure; config validation already guarantees
  // 'none' only appears in production, where this is true.
  secure: isProduction,
  sameSite: env.COOKIE_SAMESITE,
  path: '/',
} as const;

export const ACCESS_COOKIE_NAME = 'throttle_at';
export const REFRESH_COOKIE_NAME = 'throttle_rt';
export const CSRF_COOKIE_NAME = 'throttle_csrf';
export const CSRF_HEADER_NAME = 'x-csrf-token';
