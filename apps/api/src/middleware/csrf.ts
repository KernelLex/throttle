/**
 * CSRF protection — double-submit cookie pattern.
 *
 * WHY THIS IS NEEDED AT ALL
 * -------------------------
 * Sessions live in cookies, and browsers attach cookies to cross-site requests
 * automatically. Without a CSRF defence, `evil.com` can POST to our API and the
 * browser helpfully authenticates it. `SameSite=Lax` blocks the obvious cases, but
 * it is a single point of failure: it is relaxed for top-level navigations, is
 * implemented inconsistently by older browsers, and would have to be weakened to
 * `None` the moment the frontend moves to a different site.
 *
 * HOW DOUBLE-SUBMIT WORKS
 * -----------------------
 * A random token is set in a NON-httpOnly cookie. The frontend reads it and echoes it
 * in a request header. The server requires the two to match.
 *
 * The security comes from the same-origin policy: `evil.com` can cause the cookie to
 * be SENT, but cannot READ it, so it cannot populate the header. That the token
 * cookie is readable by JavaScript is intentional and safe — it is not a credential,
 * it only proves the request came from a page on our origin.
 *
 * Safe methods are exempt: they must not have side effects, so forging one achieves
 * nothing.
 */

import type { NextFunction, Request, Response } from 'express';
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, isProduction } from '../config.js';
import { generateToken, safeCompare } from '../lib/crypto.js';
import { forbidden } from '../lib/errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Paths exempt from CSRF validation.
 *
 * The OAuth callbacks are top-level redirects from an external provider, so no header
 * can be attached. They are protected instead by their own single-use `state`
 * parameter, which is a CSRF token by another name.
 */
const CSRF_EXEMPT_PATHS = new Set([
  '/api/auth/google',
  '/api/auth/google/callback',
  '/api/slack/callback',
]);

/**
 * Issue a CSRF token cookie when one is missing.
 *
 * `httpOnly: false` is REQUIRED here and is not an oversight — the frontend has to
 * read this value to echo it back. See the header comment for why that is safe.
 */
export function issueCsrfToken(req: Request, res: Response, next: NextFunction): void {
  if (!req.cookies?.[CSRF_COOKIE_NAME]) {
    res.cookie(CSRF_COOKIE_NAME, generateToken(24), {
      httpOnly: false,
      secure: isProduction,
      sameSite: 'lax',
      path: '/',
      maxAge: 24 * 60 * 60 * 1000,
    });
  }
  next();
}

export function verifyCsrf(req: Request, _res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }

  if (CSRF_EXEMPT_PATHS.has(req.path)) {
    next();
    return;
  }

  const cookieToken = req.cookies?.[CSRF_COOKIE_NAME];
  const headerToken = req.headers[CSRF_HEADER_NAME];

  if (typeof cookieToken !== 'string' || typeof headerToken !== 'string') {
    next(forbidden('Missing CSRF token. Please refresh the page and try again.'));
    return;
  }

  // Constant-time comparison: a fast-exit compare leaks how many leading characters
  // matched, which is enough to reconstruct a token given enough attempts.
  if (!safeCompare(cookieToken, headerToken)) {
    next(forbidden('Invalid CSRF token. Please refresh the page and try again.'));
    return;
  }

  next();
}
