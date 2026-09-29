/**
 * Application error types.
 *
 * THE RULE: the `message` on an AppError is shown to the user, so it must never
 * contain internal detail — no SQL, no stack traces, no upstream provider text, no
 * hostnames. Internal detail goes in `cause`, which is logged and never serialised.
 *
 * This is enforced structurally: the error handler serialises only `code`, `message`
 * and `fields`. Anything an unexpected exception carries is replaced wholesale with
 * a generic message plus a request id.
 */

import type { ApiErrorCode } from '@throttle/core';

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ApiErrorCode;
  readonly fields: Record<string, string[]> | undefined;
  /** Internal context — logged, never returned to the client. */
  readonly context: Record<string, unknown> | undefined;

  constructor(
    statusCode: number,
    code: ApiErrorCode,
    message: string,
    options?: {
      fields?: Record<string, string[]>;
      context?: Record<string, unknown>;
      cause?: unknown;
    },
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.fields = options?.fields;
    this.context = options?.context;
    Error.captureStackTrace?.(this, AppError);
  }
}

export const badRequest = (
  message: string,
  fields?: Record<string, string[]>,
  context?: Record<string, unknown>,
) => new AppError(400, 'VALIDATION_ERROR', message, { fields, context });

export const unauthenticated = (message = 'You are not signed in.') =>
  new AppError(401, 'UNAUTHENTICATED', message);

export const forbidden = (message = 'You do not have access to this resource.') =>
  new AppError(403, 'FORBIDDEN', message);

/**
 * Note the deliberately vague default. A "campaign 123 not found" for a resource that
 * belongs to *another tenant* would confirm its existence — so tenant-scoped lookups
 * return this same 404 whether the row is missing or simply not yours.
 */
export const notFound = (message = 'Not found.') => new AppError(404, 'NOT_FOUND', message);

export const conflict = (message: string, context?: Record<string, unknown>) =>
  new AppError(409, 'CONFLICT', message, { context });

export const rateLimited = (message = 'Too many requests. Please slow down.') =>
  new AppError(429, 'RATE_LIMITED', message);

export const upstreamUnavailable = (message: string, cause?: unknown) =>
  new AppError(503, 'UPSTREAM_UNAVAILABLE', message, { cause });

export const internal = (cause?: unknown, context?: Record<string, unknown>) =>
  new AppError(500, 'INTERNAL_ERROR', 'Something went wrong on our end.', { cause, context });

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

/**
 * Classify an SMTP failure as permanent or transient.
 *
 * This decides whether a send is retried, and getting it wrong is expensive in both
 * directions: retrying a permanent failure burns the retry budget and hammers a
 * provider with mail it has already refused (a fast route to a reputation problem),
 * while treating a transient failure as permanent silently drops mail the user paid
 * to send.
 *
 * SMTP 5xx is permanent, 4xx is transient — that is the protocol's own contract.
 */
export function isPermanentSmtpError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;

  const candidate = err as { responseCode?: number; code?: string; message?: string };

  if (typeof candidate.responseCode === 'number') {
    return candidate.responseCode >= 500 && candidate.responseCode < 600;
  }

  // Nodemailer surfaces auth and envelope rejections as string codes.
  const permanentCodes = ['EAUTH', 'EENVELOPE'];
  if (candidate.code && permanentCodes.includes(candidate.code)) return true;

  // Network-level problems are always worth retrying.
  const transientCodes = ['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'ECONNRESET', 'EDNS'];
  if (candidate.code && transientCodes.includes(candidate.code)) return false;

  // Unknown failures are treated as transient: retrying a few times is a smaller
  // mistake than silently discarding a message.
  return false;
}
