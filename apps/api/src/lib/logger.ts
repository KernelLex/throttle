/**
 * Structured logging.
 *
 * JSON in production (so a log aggregator can parse it), pretty-printed in dev.
 *
 * The redaction list is the important part: this app handles SMTP passwords, OAuth
 * tokens and session cookies. Pino redacts by path BEFORE serialising, so a
 * `logger.info({ req })` that happens to include an Authorization header cannot leak
 * it — which is exactly the kind of accident that happens when someone adds a debug
 * log at 2am.
 */

import pino from 'pino';
import { env, isProduction, isTest } from '../config.js';

export const logger = pino({
  level: isTest ? 'silent' : env.LOG_LEVEL,

  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      'password',
      'smtpPassword',
      'smtpPasswordEnc',
      '*.password',
      '*.smtpPassword',
      'token',
      'accessToken',
      'refreshToken',
      'botToken',
      'webhookUrl',
      'webhookUrlEnc',
      'botTokenEnc',
      'client_secret',
      'ENCRYPTION_KEY',
      'JWT_ACCESS_SECRET',
      'JWT_REFRESH_SECRET',
    ],
    censor: '[REDACTED]',
  },

  // Rename to the conventional field names most aggregators expect.
  formatters: {
    level: (label) => ({ level: label }),
  },

  base: {
    service: 'throttle',
    role: env.ROLE,
  },

  transport: isProduction
    ? undefined
    : {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname,service',
          singleLine: false,
        },
      },
});

/** Child logger with a stable component tag, so `component=worker` filters cleanly. */
export function createLogger(component: string) {
  return logger.child({ component });
}
