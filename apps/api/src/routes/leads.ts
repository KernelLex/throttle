/**
 * Lead file upload.
 *
 * The browser already parses the file locally to show an instant count. This endpoint
 * exists because that count is UX, not truth — the server must derive the recipient
 * list from the actual bytes it received.
 *
 * UPLOAD HARDENING
 * ----------------
 *   - memoryStorage, never disk: nothing user-supplied is written to the filesystem,
 *     which removes path traversal and leftover-temp-file concerns entirely
 *   - hard byte cap from MAX_UPLOAD_BYTES, enforced by multer before we see the data
 *   - exactly one file per request
 *   - extension AND content sniffing: the file must actually look like text
 *   - recipient count capped by MAX_LEADS_PER_CAMPAIGN
 */

import { Router } from 'express';
import multer from 'multer';
import { MAX_LEADS_PER_CAMPAIGN, parseLeads, type ApiResponse, type ParsedLeads } from '@throttle/core';
import { env } from '../config.js';
import { badRequest } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/validate.js';

export const leadsRouter = Router();

leadsRouter.use(requireAuth);

const ALLOWED_EXTENSIONS = new Set(['.csv', '.txt', '.tsv']);

const upload = multer({
  // In memory: the file is parsed and discarded within the request. Writing it to
  // disk would create a cleanup obligation and an attack surface for no benefit.
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.MAX_UPLOAD_BYTES,
    files: 1,
    // Bound the multipart parser itself, not just the file.
    fields: 10,
    parts: 12,
  },
  fileFilter: (_req, file, callback) => {
    const name = file.originalname.toLowerCase();
    const extension = name.slice(name.lastIndexOf('.'));

    if (!ALLOWED_EXTENSIONS.has(extension)) {
      callback(new Error('Only .csv, .txt and .tsv files are supported.'));
      return;
    }
    callback(null, true);
  },
});

/**
 * Reject binary content.
 *
 * The extension is attacker-controlled, so a `.csv` that is really a JPEG or a zip
 * gets this far. A NUL byte in the first kilobyte is a cheap, reliable signal that
 * the content is not text — and parsing a binary blob as a lead list would otherwise
 * produce thousands of garbage "addresses".
 */
function looksLikeText(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 1024);
  return !sample.includes(0);
}

// ── POST /api/leads/parse ─────────────────────────────────────────────────────

leadsRouter.post(
  '/parse',
  (req, res, next) => {
    upload.single('file')(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          next(
            badRequest(
              `That file is too large. The limit is ${Math.floor(env.MAX_UPLOAD_BYTES / 1024 / 1024)} MB.`,
            ),
          );
          return;
        }
        next(badRequest(err.message));
        return;
      }
      if (err instanceof Error) {
        next(badRequest(err.message));
        return;
      }
      next();
    });
  },
  asyncHandler(async (req, res) => {
    const file = req.file;
    if (!file) throw badRequest('No file was uploaded.');

    if (!looksLikeText(file.buffer)) {
      throw badRequest('That file does not look like a text or CSV file.');
    }

    // `latin1` rather than `utf8` so a mis-encoded byte becomes a character that
    // fails email validation, instead of a U+FFFD replacement char that could
    // silently corrupt an otherwise-valid address.
    const text = file.buffer.toString('latin1');
    const parsed = parseLeads(text, MAX_LEADS_PER_CAMPAIGN);

    if (parsed.emails.length === 0) {
      throw badRequest(
        'No valid email addresses were found in that file. Check that it contains one address per line, or a column of addresses.',
      );
    }

    const body: ApiResponse<ParsedLeads> = { ok: true, data: parsed };
    res.json(body);
  }),
);
