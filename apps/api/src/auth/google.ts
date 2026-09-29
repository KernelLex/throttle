/**
 * Google OAuth 2.0 — authorization code flow with PKCE.
 *
 * WHY THE BACKEND OWNS THIS
 * -------------------------
 * The implicit flow (token straight to the browser) is deprecated, and any flow that
 * puts a client secret in frontend code is not a secret at all. Running the exchange
 * server-side means the code-for-token swap happens over a channel the browser never
 * sees, and the resulting session lands in an httpOnly cookie that JavaScript — ours
 * or an injected script's — cannot read.
 *
 * PKCE ON TOP OF A CONFIDENTIAL CLIENT
 * ------------------------------------
 * PKCE is strictly required only for public clients. It is used here anyway because
 * it closes authorization-code interception: even if the `code` leaks from a redirect
 * (browser history, a proxy log, a misconfigured referrer policy), it is useless
 * without the `code_verifier`, which never leaves this server.
 *
 * STATE
 * -----
 * `state` is single-use and stored in Redis with a short TTL. It carries the PKCE
 * verifier and the post-login redirect. Being single-use is what makes it a real CSRF
 * defence rather than a formality — a replayed callback finds the key already
 * consumed and is rejected.
 */

import { createHash, randomBytes } from 'node:crypto';
import { OAUTH_STATE_TTL_SECONDS, oauthStateKey } from '@throttle/core';
import { env, googleRedirectUri } from '../config.js';
import { badRequest, upstreamUnavailable } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { redis } from '../lib/redis.js';

const log = createLogger('google-oauth');

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

interface StoredState {
  codeVerifier: string;
  redirectTo: string;
  createdAt: number;
}

/** RFC 7636 S256 challenge. */
function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * Build the URL to send the user to.
 *
 * `redirectTo` is validated by the caller against an allowlist — accepting an
 * arbitrary value here would make this an open redirect, a classic phishing primitive
 * (the link genuinely is your domain, right up until the redirect).
 */
export async function buildAuthorizationUrl(redirectTo = '/'): Promise<string> {
  const state = randomBytes(24).toString('base64url');
  const { verifier, challenge } = createPkcePair();

  const stored: StoredState = { codeVerifier: verifier, redirectTo, createdAt: Date.now() };
  await redis.set(
    oauthStateKey(state),
    JSON.stringify(stored),
    'EX',
    OAUTH_STATE_TTL_SECONDS,
  );

  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: googleRedirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    // `select_account` so signing out and back in as a different user actually
    // offers the account picker instead of silently reusing the last session.
    prompt: 'select_account',
  });

  if (env.GOOGLE_ALLOWED_HOSTED_DOMAIN) {
    // A UI hint only. The real check happens after token exchange — `hd` in the
    // request is trivially removable by anyone driving the flow manually.
    params.set('hd', env.GOOGLE_ALLOWED_HOSTED_DOMAIN);
  }

  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

/**
 * Consume a `state` value.
 *
 * Uses GETDEL so the read and the delete are atomic: two concurrent callbacks with
 * the same state cannot both succeed.
 */
export async function consumeState(state: string): Promise<StoredState> {
  const raw = await redis.getdel(oauthStateKey(state));
  if (!raw) {
    throw badRequest(
      'This sign-in link has expired or was already used. Please try signing in again.',
    );
  }
  return JSON.parse(raw) as StoredState;
}

export interface GoogleProfile {
  googleId: string;
  email: string;
  emailVerified: boolean;
  name: string;
  avatarUrl: string | null;
  hostedDomain: string | null;
}

/** Exchange the authorization code and fetch the profile. */
export async function exchangeCodeForProfile(
  code: string,
  codeVerifier: string,
): Promise<GoogleProfile> {
  const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: googleRedirectUri,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    }),
  });

  if (!tokenResponse.ok) {
    const detail = await tokenResponse.text();
    // The provider's error text goes to the log, never to the user — it can echo
    // request parameters back.
    log.error({ status: tokenResponse.status, detail }, 'Google token exchange failed');
    throw upstreamUnavailable('Could not complete sign-in with Google. Please try again.');
  }

  const tokens = (await tokenResponse.json()) as { access_token?: string };
  if (!tokens.access_token) {
    throw upstreamUnavailable('Google did not return an access token.');
  }

  const profileResponse = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });

  if (!profileResponse.ok) {
    log.error({ status: profileResponse.status }, 'Google userinfo request failed');
    throw upstreamUnavailable('Could not read your Google profile. Please try again.');
  }

  const profile = (await profileResponse.json()) as {
    sub: string;
    email: string;
    email_verified?: boolean;
    name?: string;
    picture?: string;
    hd?: string;
  };

  // An unverified address must not be trusted as an identity — someone can create a
  // Google account claiming an address they do not control.
  if (profile.email_verified === false) {
    throw badRequest('Your Google email address is not verified.');
  }

  // Enforce the domain restriction HERE, on the token-exchange response, not on the
  // `hd` request parameter which the user controls.
  if (
    env.GOOGLE_ALLOWED_HOSTED_DOMAIN &&
    profile.hd !== env.GOOGLE_ALLOWED_HOSTED_DOMAIN
  ) {
    throw badRequest(
      `Sign-in is restricted to ${env.GOOGLE_ALLOWED_HOSTED_DOMAIN} accounts.`,
    );
  }

  return {
    googleId: profile.sub,
    email: profile.email.toLowerCase(),
    emailVerified: profile.email_verified ?? true,
    name: profile.name ?? profile.email.split('@')[0]!,
    avatarUrl: profile.picture ?? null,
    hostedDomain: profile.hd ?? null,
  };
}

/**
 * Validate a post-login redirect target.
 *
 * Only same-origin PATHS are accepted — no absolute URLs, no protocol-relative
 * `//evil.com` (which a naive `startsWith('/')` check would happily allow).
 */
export function sanitiseRedirect(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return '/';
  if (!value.startsWith('/')) return '/';
  if (value.startsWith('//')) return '/';
  if (value.includes('\\')) return '/';
  return value;
}
