/**
 * Zod schemas shared between API request validation and frontend form validation.
 *
 * Declaring these once means the browser and the server cannot disagree about what a
 * valid campaign looks like — the form shows the same error the API would return.
 * The server still re-validates everything: client-side validation is UX, never a
 * security boundary.
 */

import { z } from 'zod';
import {
  MAX_BODY_LENGTH,
  MAX_CAMPAIGN_NAME_LENGTH,
  MAX_GAP_MS,
  MAX_HOURLY_LIMIT,
  MAX_LEADS_PER_CAMPAIGN,
  MAX_SCHEDULE_HORIZON_MS,
  MAX_START_BACKDATE_MS,
  MAX_SUBJECT_LENGTH,
  MIN_GAP_MS,
  MIN_HOURLY_LIMIT,
} from './constants.js';
import { isValidEmail } from './leads.js';

// ── Primitives ────────────────────────────────────────────────────────────────

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .refine(isValidEmail, { message: 'Not a valid email address' });

export const cuidLikeIdSchema = z.string().min(1).max(64);

/** ISO-8601 datetime string that parses to a finite epoch. */
export const isoDateTimeSchema = z
  .string()
  .datetime({ offset: true })
  .or(z.string().datetime())
  .refine((value) => Number.isFinite(Date.parse(value)), {
    message: 'Not a valid ISO-8601 datetime',
  });

// ── Campaign creation ─────────────────────────────────────────────────────────

export const createCampaignSchema = z
  .object({
    name: z.string().trim().min(1).max(MAX_CAMPAIGN_NAME_LENGTH),
    subject: z.string().trim().min(1).max(MAX_SUBJECT_LENGTH),
    body: z.string().min(1).max(MAX_BODY_LENGTH),

    /** Deduped server-side again regardless of what the client sends. */
    recipients: z
      .array(emailSchema)
      .min(1, 'At least one recipient is required')
      .max(MAX_LEADS_PER_CAMPAIGN, `At most ${MAX_LEADS_PER_CAMPAIGN} recipients per campaign`),

    startAt: isoDateTimeSchema,

    minGapMs: z.number().int().min(MIN_GAP_MS).max(MAX_GAP_MS),

    hourlyLimitPerSender: z.number().int().min(MIN_HOURLY_LIMIT).max(MAX_HOURLY_LIMIT),

    /** Optional explicit sender selection. Omitted ⇒ all active senders are used. */
    senderIds: z.array(cuidLikeIdSchema).max(100).optional(),
  })
  .superRefine((value, ctx) => {
    // Timing checks live here rather than in the field schemas because they compare
    // against the current clock, which makes them inherently non-pure. The planner
    // stays pure; validation is where clock-awareness belongs.
    const startMs = Date.parse(value.startAt);
    const now = Date.now();

    if (startMs < now - MAX_START_BACKDATE_MS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['startAt'],
        message:
          'Start time is more than 5 minutes in the past. Pick a future time — a large ' +
          'backdate usually means a timezone mix-up.',
      });
    }

    if (startMs > now + MAX_SCHEDULE_HORIZON_MS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['startAt'],
        message: 'Start time is more than 90 days out.',
      });
    }
  });

export type CreateCampaignInput = z.infer<typeof createCampaignSchema>;

// ── Sender management ─────────────────────────────────────────────────────────

export const createSenderSchema = z.object({
  label: z.string().trim().min(1).max(100),
  fromName: z.string().trim().min(1).max(100),
  fromEmail: emailSchema,
  smtpHost: z.string().trim().min(1).max(255),
  smtpPort: z.number().int().min(1).max(65535),
  smtpUser: z.string().trim().min(1).max(255),
  smtpPassword: z.string().min(1).max(500),
  smtpSecure: z.boolean().default(false),
  hourlyLimit: z.number().int().min(MIN_HOURLY_LIMIT).max(MAX_HOURLY_LIMIT),
  minGapMs: z.number().int().min(MIN_GAP_MS).max(MAX_GAP_MS),
});

export type CreateSenderInput = z.infer<typeof createSenderSchema>;

export const updateSenderSchema = createSenderSchema
  .partial()
  .extend({ isActive: z.boolean().optional() });

export type UpdateSenderInput = z.infer<typeof updateSenderSchema>;

// ── Listing / search ──────────────────────────────────────────────────────────

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const listEmailsSchema = paginationSchema.extend({
  status: z
    .enum(['SCHEDULED', 'QUEUED', 'SENDING', 'SENT', 'FAILED', 'CANCELLED', 'RESCHEDULED'])
    .optional(),
  campaignId: cuidLikeIdSchema.optional(),
  senderId: cuidLikeIdSchema.optional(),
  /** Convenience grouping used by the dashboard tabs. */
  bucket: z.enum(['scheduled', 'sent']).optional(),
  sortBy: z.enum(['scheduledAt', 'sentAt', 'createdAt']).default('scheduledAt'),
  sortDir: z.enum(['asc', 'desc']).default('asc'),
});

export const searchEmailsSchema = paginationSchema.extend({
  /**
   * NOTE: there is deliberately no `tenantId` field. The tenant filter is injected
   * server-side from the session. Accepting it from the client would be an IDOR.
   */
  q: z.string().trim().min(1).max(500),
  status: z
    .enum(['SCHEDULED', 'QUEUED', 'SENDING', 'SENT', 'FAILED', 'CANCELLED', 'RESCHEDULED'])
    .optional(),
  campaignId: cuidLikeIdSchema.optional(),
  senderId: cuidLikeIdSchema.optional(),
  from: isoDateTimeSchema.optional(),
  to: isoDateTimeSchema.optional(),
});

export type ListEmailsQuery = z.infer<typeof listEmailsSchema>;
export type SearchEmailsQuery = z.infer<typeof searchEmailsSchema>;

// ── Preview / planning ────────────────────────────────────────────────────────

/** Body for `POST /api/campaigns/preview` — lets the server confirm the client's
 *  forecast using the real sender list, without creating anything. */
export const previewPlanSchema = z.object({
  recipientCount: z.number().int().min(0).max(MAX_LEADS_PER_CAMPAIGN),
  startAt: isoDateTimeSchema,
  minGapMs: z.number().int().min(MIN_GAP_MS).max(MAX_GAP_MS),
  hourlyLimitPerSender: z.number().int().min(MIN_HOURLY_LIMIT).max(MAX_HOURLY_LIMIT),
  senderIds: z.array(cuidLikeIdSchema).max(100).optional(),
});

export type PreviewPlanInput = z.infer<typeof previewPlanSchema>;
