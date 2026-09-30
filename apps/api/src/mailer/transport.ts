/**
 * SMTP transport management.
 *
 * CONNECTION POOLING
 * ------------------
 * Transports are cached per sender and reused. Creating a fresh Nodemailer transport
 * per email would open a new TCP + TLS + AUTH handshake every time — roughly
 * 200–500ms of pure overhead per send, and a fast route to Ethereal's connection
 * limits. Pooled transports keep connections warm.
 *
 * The cache is keyed by sender id AND a hash of the credentials, so editing a
 * sender's SMTP settings invalidates the old transport instead of silently continuing
 * to use stale credentials — a genuinely confusing bug to chase otherwise.
 */

import nodemailer, { type Transporter } from 'nodemailer';
import type SMTPPool from 'nodemailer/lib/smtp-pool/index.js';
import { env } from '../config.js';
import { decrypt } from '../lib/crypto.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('smtp');

export interface SenderCredentials {
  id: string;
  label: string;
  fromName: string;
  fromEmail: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPasswordEnc: string;
  smtpSecure: boolean;
}

/** Every transport here is created with `pool: true`, so it carries SMTPPool's
 *  result type rather than SMTPTransport's. */
export type PooledTransporter = Transporter<SMTPPool.SentMessageInfo>;

interface CachedTransport {
  transporter: PooledTransporter;
  credentialsFingerprint: string;
}

/**
 * A sender as the worker needs it: SMTP credentials PLUS the scheduling policy the
 * rate limiter applies. Kept separate from SenderCredentials so the transport layer
 * stays unaware of rate limiting.
 */
export interface PoolSender extends SenderCredentials {
  hourlyLimit: number;
  minGapMs: number;
}

const transportCache = new Map<string, CachedTransport>();

/** Cheap, non-cryptographic key for "did the SMTP settings change?". */
function fingerprintCredentials(sender: SenderCredentials): string {
  return [
    sender.smtpHost,
    sender.smtpPort,
    sender.smtpUser,
    sender.smtpSecure,
    // The ciphertext changes whenever the password is re-encrypted, which is exactly
    // the invalidation signal we want.
    sender.smtpPasswordEnc.slice(-16),
  ].join('|');
}

export function getTransport(sender: SenderCredentials): PooledTransporter {
  const fingerprint = fingerprintCredentials(sender);
  const cached = transportCache.get(sender.id);

  if (cached && cached.credentialsFingerprint === fingerprint) {
    return cached.transporter;
  }

  // Credentials changed — tear the old pool down rather than leaking its sockets.
  if (cached) {
    log.info({ senderId: sender.id }, 'SMTP credentials changed — rebuilding transport');
    cached.transporter.close();
  }

  const transporter = nodemailer.createTransport({
    host: sender.smtpHost,
    port: sender.smtpPort,
    secure: sender.smtpSecure,
    auth: {
      user: sender.smtpUser,
      pass: decrypt(sender.smtpPasswordEnc),
    },

    pool: true,
    maxConnections: env.SMTP_POOL_MAX_CONNECTIONS,
    // Nodemailer would otherwise pipeline many messages down one connection, which
    // defeats the per-send pacing we enforce in Redis.
    maxMessages: 100,

    connectionTimeout: env.SMTP_CONNECTION_TIMEOUT_MS,
    greetingTimeout: env.SMTP_CONNECTION_TIMEOUT_MS,
    socketTimeout: env.SMTP_CONNECTION_TIMEOUT_MS * 2,
  });

  transportCache.set(sender.id, { transporter, credentialsFingerprint: fingerprint });
  log.debug({ senderId: sender.id, host: sender.smtpHost }, 'SMTP transport created');

  return transporter;
}

/** Drop a sender's cached transport — called when a sender is edited or deleted. */
export function invalidateTransport(senderId: string): void {
  const cached = transportCache.get(senderId);
  if (cached) {
    cached.transporter.close();
    transportCache.delete(senderId);
    log.debug({ senderId }, 'SMTP transport invalidated');
  }
}

export function closeAllTransports(): void {
  for (const { transporter } of transportCache.values()) transporter.close();
  transportCache.clear();
  log.info('All SMTP transports closed');
}

/**
 * Verify a sender's credentials without sending anything.
 *
 * Used when adding a sender, so a typo is caught at configuration time rather than
 * discovered three hours later when the first scheduled email fails.
 */
export async function verifyTransport(
  sender: SenderCredentials,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await getTransport(sender).verify();
    return { ok: true };
  } catch (err) {
    invalidateTransport(sender.id);
    return { ok: false, error: err instanceof Error ? err.message : 'Unknown SMTP error' };
  }
}

/**
 * Provision a throwaway Ethereal mailbox.
 *
 * Ethereal accepts mail and renders it at a preview URL but never delivers it, which
 * is what makes it safe to fire a thousand test emails at.
 *
 * WHY THIS CALLS THE API DIRECTLY INSTEAD OF nodemailer.createTestAccount()
 * ------------------------------------------------------------------------
 * `createTestAccount()` CACHES its result for the lifetime of the process — calling
 * it three times returns the same mailbox three times. The seed script then hits the
 * unique constraint on (tenantId, fromEmail) and only one sender was created, which
 * quietly guts the entire multi-sender story: no rotation to demonstrate, no circuit
 * breaker rerouting, no per-sender rate limits.
 *
 * Posting to the API directly returns a distinct mailbox per call.
 */
export async function createEtherealAccount(): Promise<{
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPassword: string;
  smtpSecure: boolean;
  webUrl: string;
}> {
  const response = await fetch('https://api.nodemailer.com/user', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestor: 'throttle', version: '1.0.0' }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    throw new Error(
      `Ethereal account provisioning failed (HTTP ${response.status}). ` +
        'Check your internet connection, or create accounts manually at https://ethereal.email/create',
    );
  }

  const account = (await response.json()) as {
    user: string;
    pass: string;
    smtp: { host: string; port: number; secure: boolean };
  };

  return {
    smtpHost: account.smtp.host,
    smtpPort: account.smtp.port,
    smtpUser: account.user,
    smtpPassword: account.pass,
    smtpSecure: account.smtp.secure,
    webUrl: 'https://ethereal.email/login',
  };
}
