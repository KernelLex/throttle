/**
 * Message construction and delivery.
 */

import nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js';
import { createLogger } from '../lib/logger.js';
import { getTransport, type SenderCredentials } from './transport.js';

const log = createLogger('mailer');

export interface SendParams {
  sender: SenderCredentials;
  to: string;
  toName?: string | null;
  subject: string;
  body: string;
  mergeData?: Record<string, unknown> | null;
  /** Set as the SMTP Message-ID so a send can be traced end to end. */
  messageIdSeed: string;
}

export interface SendSuccess {
  ok: true;
  messageId: string;
  /** Ethereal's rendered-message URL — the visible proof a send really happened. */
  previewUrl: string | null;
  acceptedCount: number;
}

export interface SendFailure {
  ok: false;
  error: string;
  /** The raw error, so the caller can classify it as permanent vs transient. */
  cause: unknown;
}

/**
 * Substitute `{{key}}` placeholders.
 *
 * Deliberately NOT a template engine. Handlebars or EJS would execute code from what
 * is effectively user-supplied input (a campaign body), which is a server-side
 * template-injection risk for a feature that only ever needs string replacement.
 *
 * Unknown placeholders are left verbatim rather than blanked, so a typo in
 * `{{firstNme}}` is visible in the preview instead of silently producing "Hi ,".
 */
export function renderTemplate(
  template: string,
  mergeData: Record<string, unknown> | null | undefined,
  recipientEmail: string,
): string {
  const values: Record<string, unknown> = {
    email: recipientEmail,
    ...(mergeData ?? {}),
  };

  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key: string) => {
    const value = values[key];
    if (value === undefined || value === null) return match;
    return String(value);
  });
}

/** Minimal HTML escaping for the auto-generated HTML part. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Wrap a plain-text body in simple HTML, preserving paragraph breaks. */
function toHtml(text: string): string {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br/>')}</p>`)
    .join('\n');

  return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a;">${paragraphs}</body></html>`;
}

/**
 * Send one email.
 *
 * Never throws — every outcome is returned as a discriminated union. The worker needs
 * to record a failure in Postgres and update circuit-breaker state before deciding
 * whether to retry, and an exception mid-way through that sequence would leave the
 * job in SENDING with nothing recorded.
 */
export async function sendEmail(params: SendParams): Promise<SendSuccess | SendFailure> {
  const { sender, to, subject, body, mergeData, messageIdSeed } = params;

  try {
    const renderedSubject = renderTemplate(subject, mergeData, to);
    const renderedBody = renderTemplate(body, mergeData, to);

    const info = await getTransport(sender).sendMail({
      from: { name: sender.fromName, address: sender.fromEmail },
      to: params.toName ? { name: params.toName, address: to } : to,
      subject: renderedSubject,
      text: renderedBody,
      html: toHtml(renderedBody),
      // Deterministic Message-ID derived from the EmailJob id: if a message somehow
      // reached the provider twice, both copies carry the same id and the duplicate
      // is provable rather than merely suspected.
      messageId: `<${messageIdSeed}@throttle.local>`,
      headers: {
        'X-Throttle-Job-Id': messageIdSeed,
        'X-Throttle-Sender-Id': sender.id,
      },
    });

    return {
      ok: true,
      messageId: info.messageId,
      // @types/nodemailer types getTestMessageUrl() against the NON-pooled
      // SentMessageInfo. Our transports use `pool: true`, whose result type differs
      // only in a `pending` field that this function never reads — it derives the
      // Ethereal URL from the message id and response alone. Narrow, documented cast
      // in preference to widening the whole call site to `any`.
      previewUrl:
        nodemailer.getTestMessageUrl(info as unknown as SMTPTransport.SentMessageInfo) || null,
      acceptedCount: info.accepted?.length ?? 0,
    };
  } catch (err) {
    log.warn(
      { err, senderId: sender.id, to },
      'SMTP send failed',
    );
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Unknown SMTP error',
      cause: err,
    };
  }
}
