/**
 * Authentication and authorisation middleware.
 *
 * DESIGN RULE: there is no "optional auth" middleware in this codebase.
 *
 * Optional-auth helpers are how endpoints end up public by accident — a handler that
 * reads `req.user?.tenantId` and falls back to something sensible when it is
 * undefined will happily serve every tenant's data the day someone forgets to mount
 * the guard. Every route either requires authentication or is explicitly listed in
 * PUBLIC_PATHS below, and a test asserts that nothing else escapes.
 */

import type { NextFunction, Request, Response } from 'express';
import type { Role } from '@prisma/client';
import { ACCESS_COOKIE_NAME } from '../config.js';
import { forbidden, unauthenticated } from '../lib/errors.js';
import { verifyAccessToken } from '../auth/tokens.js';

/** The authenticated principal, attached by `requireAuth`. */
export interface AuthContext {
  userId: string;
  tenantId: string;
  role: Role;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
      requestId?: string;
    }
  }
}

/**
 * The complete list of paths that do NOT require authentication.
 *
 * Adding to this list should feel uncomfortable. Each entry is justified:
 *   /healthz, /readyz            — infrastructure probes, expose no tenant data
 *   /api/auth/google             — starts the login flow; nobody is signed in yet
 *   /api/auth/google/callback    — Google redirects here pre-session
 *   /api/auth/refresh            — authenticates via the refresh cookie, not the access one
 *   /api/auth/logout             — must work even with an expired access token
 *   /api/slack/callback          — Slack redirects here; protected by a signed state token
 *   /api/config                  — which login providers are enabled (no secrets)
 */
export const PUBLIC_PATHS: readonly string[] = [
  '/healthz',
  '/readyz',
  '/api/config',
  '/api/auth/google',
  '/api/auth/google/callback',
  '/api/auth/refresh',
  '/api/auth/logout',
  '/api/slack/callback',
];

export function isPublicPath(path: string): boolean {
  return PUBLIC_PATHS.includes(path);
}

/**
 * Read the bearer token.
 *
 * The cookie is preferred over the Authorization header. The header is accepted only
 * to keep Postman and the demo script usable; browsers always use the httpOnly
 * cookie, which is the path that actually matters for XSS resistance.
 */
function extractToken(req: Request): string | null {
  const cookieToken = req.cookies?.[ACCESS_COOKIE_NAME];
  if (typeof cookieToken === 'string' && cookieToken.length > 0) return cookieToken;

  const header = req.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return header.slice(7);
  }

  return null;
}

/** Reject anything without a valid session. */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const token = extractToken(req);
  if (!token) {
    next(unauthenticated());
    return;
  }

  const payload = verifyAccessToken(token);
  if (!payload) {
    // Deliberately identical message whether the token was expired, forged or
    // malformed. The frontend distinguishes them by attempting a refresh, not by
    // reading the error.
    next(unauthenticated('Your session has expired. Please sign in again.'));
    return;
  }

  req.auth = { userId: payload.sub, tenantId: payload.tid, role: payload.role };
  next();
}

/**
 * Require a specific role.
 *
 * Mounted AFTER requireAuth. The missing-context case throws rather than treating it
 * as unauthenticated, because reaching here without `req.auth` means the middleware
 * was mounted in the wrong order — a bug to surface loudly, not to paper over.
 */
export function requireRole(...roles: Role[]) {
  // Named (not anonymous) so it is identifiable by name in the Express router stack.
  // `routeSecurity.test.ts` inspects those names to prove every route is guarded, and
  // an anonymous closure would be invisible to it.
  return function requireRoleGuard(req: Request, _res: Response, next: NextFunction): void {
    if (!req.auth) {
      next(unauthenticated());
      return;
    }

    if (!roles.includes(req.auth.role)) {
      next(forbidden('This action requires administrator access.'));
      return;
    }

    next();
  };
}

/**
 * Read the authenticated context, throwing if absent.
 *
 * Handlers call this instead of reading `req.auth` directly, which means a handler
 * mounted without `requireAuth` fails immediately and visibly rather than silently
 * operating on `undefined`.
 */
export function getAuth(req: Request): AuthContext {
  if (!req.auth) {
    throw unauthenticated('This endpoint requires authentication.');
  }
  return req.auth;
}
