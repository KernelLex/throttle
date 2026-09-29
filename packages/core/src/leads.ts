/**
 * Lead-file parsing.
 *
 * Runs in BOTH places, for the same reason the planner does:
 *   - the browser, to show "1,000 addresses detected" the instant a file is dropped,
 *     without a round-trip
 *   - the server, because the browser's count is a convenience and NEVER a security
 *     boundary. The server re-parses the uploaded file and uses its own result.
 *
 * Accepts whatever a sales team is likely to hand you: a bare newline-separated list,
 * a CSV with headers, a CSV without headers, comma/semicolon/tab delimiters, quoted
 * fields, and stray whitespace or mailto: prefixes.
 */

import { MAX_LEADS_PER_CAMPAIGN } from './constants.js';
import type { ParsedLeads } from './types.js';

/**
 * Deliberately pragmatic, not RFC 5322.
 *
 * A full RFC 5322 regex accepts things no SMTP server will take and is unreadable.
 * This covers the addresses that actually appear in lead lists while rejecting the
 * common garbage (missing TLD, double dots, leading/trailing dots, spaces).
 */
const EMAIL_RE =
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i;

/** Maximum bytes we will parse client- or server-side. Guards against zip-bomb-ish input. */
export const MAX_LEAD_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

const INVALID_SAMPLE_LIMIT = 10;

export function isValidEmail(value: string): boolean {
  if (value.length === 0 || value.length > 254) return false;
  const at = value.lastIndexOf('@');
  if (at <= 0) return false;
  // SMTP caps the local part at 64 octets; reject early rather than at send time.
  if (at > 64) return false;
  return EMAIL_RE.test(value);
}

/**
 * Strip the decoration that shows up around addresses in exported lead lists:
 * surrounding quotes, angle brackets, `mailto:` prefixes, trailing punctuation.
 */
function normaliseCandidate(raw: string): string {
  let value = raw.trim();
  if (value.length === 0) return '';

  // "user@example.com" or 'user@example.com'
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
    (value.startsWith("'") && value.endsWith("'") && value.length > 1)
  ) {
    value = value.slice(1, -1).trim();
  }

  // Display-name form: Jane Doe <jane@example.com>
  const angle = value.match(/<([^>]+)>/);
  if (angle?.[1]) value = angle[1].trim();

  if (value.toLowerCase().startsWith('mailto:')) value = value.slice(7).trim();

  // Trailing separators left by sloppy CSV export.
  value = value.replace(/[;,]+$/, '').trim();

  return value.toLowerCase();
}

/**
 * Split a single CSV line into fields, honouring double-quoted fields that contain
 * the delimiter. Full RFC 4180 (embedded newlines inside quotes) is out of scope —
 * we document that in the README rather than pretending otherwise.
 */
function splitDelimited(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;

    if (char === '"') {
      // Escaped quote inside a quoted field: ""
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && (char === ',' || char === ';' || char === '\t')) {
      fields.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  fields.push(current);
  return fields;
}

/**
 * Parse raw file text into a deduped, validated address list.
 *
 * Dedup is case-insensitive and first-seen-wins, which preserves the ordering the user
 * uploaded — and ordering matters, because `planSchedule()` deals recipients to senders
 * in exactly this order.
 */
export function parseLeads(text: string, maxLeads: number = MAX_LEADS_PER_CAMPAIGN): ParsedLeads {
  const seen = new Set<string>();
  const emails: string[] = [];
  const invalidSamples: string[] = [];

  let totalFound = 0;
  let duplicateCount = 0;
  let invalidCount = 0;
  let truncated = false;

  // Handle CRLF, LF and lone CR line endings.
  const lines = text.split(/\r\n|\r|\n/);

  for (const line of lines) {
    if (line.trim().length === 0) continue;

    for (const field of splitDelimited(line)) {
      const candidate = normaliseCandidate(field);
      if (candidate.length === 0) continue;

      // Skip anything with no `@` at all without counting it — those are almost
      // always other CSV columns (names, companies), not malformed addresses.
      // Counting them as "invalid" would produce an alarming and useless number.
      if (!candidate.includes('@')) continue;

      totalFound++;

      if (!isValidEmail(candidate)) {
        invalidCount++;
        if (invalidSamples.length < INVALID_SAMPLE_LIMIT) invalidSamples.push(field.trim());
        continue;
      }

      if (seen.has(candidate)) {
        duplicateCount++;
        continue;
      }

      if (emails.length >= maxLeads) {
        truncated = true;
        continue;
      }

      seen.add(candidate);
      emails.push(candidate);
    }
  }

  return {
    emails,
    totalFound,
    validCount: emails.length,
    duplicateCount,
    invalidCount,
    invalidSamples,
    truncated,
  };
}
