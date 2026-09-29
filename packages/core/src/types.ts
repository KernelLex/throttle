/**
 * Domain types shared by the API, the worker and the web app.
 *
 * Anything in here is part of the contract between backend and frontend. Response
 * shapes live in `api-types.ts`; this file holds the scheduling domain itself.
 */

// ── Scheduling ────────────────────────────────────────────────────────────────

/** The subset of a Sender the planner needs. Deliberately minimal so the frontend
 *  can construct one without knowing about SMTP credentials. */
export interface PlanSender {
  id: string;
  label: string;
  /** Max emails this sender may send within a single wall-clock hour window. */
  hourlyLimit: number;
  /** This sender's own minimum spacing. The campaign floor may raise it, never lower it. */
  minGapMs: number;
}

export interface PlanInput {
  /** Already deduped and validated — run `parseLeads()` first. */
  recipients: string[];
  senders: PlanSender[];
  /**
   * Epoch ms. Passed in explicitly and never read from the clock, so `planSchedule`
   * stays a pure function and the frontend forecast matches the backend schedule
   * byte for byte.
   */
  startAt: number;
  /** Campaign-level floor on spacing between two sends from the same sender. */
  minGapMs: number;
}

export interface PlannedJob {
  /** Global submission order. Preserved through rescheduling so ordering survives
   *  a rate-limit bounce. */
  sequenceNo: number;
  recipient: string;
  senderId: string;
  /** Epoch ms this send is planned for. */
  scheduledAt: number;
  /** Wall-clock hour window this send falls in — matches the Redis counter bucket. */
  windowStart: number;
  /** 0-based position of this send within that sender's usage of that window. */
  slotInWindow: number;
}

export interface WindowSenderBreakdown {
  senderId: string;
  label: string;
  count: number;
}

export interface WindowSummary {
  windowStart: number;
  windowEnd: number;
  /** Total emails planned in this window across all senders. Drives the bar chart. */
  count: number;
  bySender: WindowSenderBreakdown[];
  /** Total capacity available in this window, for the "how full is it" bar fill. */
  capacity: number;
}

export type PlanWarningCode =
  | 'GAP_CAPS_HOURLY_LIMIT'
  | 'SINGLE_SENDER_NO_FAILOVER'
  | 'LONG_RUNNING_CAMPAIGN'
  | 'START_TIME_IN_PAST'
  | 'PARTIAL_FIRST_WINDOW';

export interface PlanWarning {
  code: PlanWarningCode;
  message: string;
  /** Which sender this relates to, when applicable. */
  senderId?: string;
}

export interface SenderPlanSummary {
  senderId: string;
  label: string;
  assigned: number;
  /** Gap actually used: max(campaign floor, sender's own). */
  effectiveGapMs: number;
  /** Per-hour ceiling actually applied: min(hourlyLimit, gap-imposed cap). */
  effectiveHourlyCapacity: number;
  firstSendAt: number | null;
  lastSendAt: number | null;
}

export interface PlanResult {
  jobs: PlannedJob[];
  windows: WindowSummary[];
  senders: SenderPlanSummary[];
  startsAt: number;
  finishesAt: number;
  /** Number of distinct hour windows the campaign touches. */
  windowCount: number;
  totalRecipients: number;
  /** Sum of every sender's effective hourly capacity. */
  totalCapacityPerHour: number;
  /** finishesAt - startsAt, in ms. */
  durationMs: number;
  warnings: PlanWarning[];
}

// ── Lead parsing ──────────────────────────────────────────────────────────────

export interface ParsedLeads {
  /** Valid, deduped, lowercased addresses in first-seen order. */
  emails: string[];
  /** Total non-empty candidate tokens examined. */
  totalFound: number;
  validCount: number;
  duplicateCount: number;
  invalidCount: number;
  /** Capped sample of rejected values, for showing the user what was dropped. */
  invalidSamples: string[];
  /** True when the input was truncated at MAX_LEADS_PER_CAMPAIGN. */
  truncated: boolean;
}

// ── Status enums (mirrored in the Prisma schema) ──────────────────────────────

export const EMAIL_STATUSES = [
  'SCHEDULED',
  'QUEUED',
  'SENDING',
  'SENT',
  'FAILED',
  'CANCELLED',
  'RESCHEDULED',
] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

export const CAMPAIGN_STATUSES = [
  'DRAFT',
  'SCHEDULED',
  'RUNNING',
  'PAUSED',
  'COMPLETED',
  'CANCELLED',
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const CIRCUIT_STATES = ['CLOSED', 'OPEN', 'HALF_OPEN'] as const;
export type CircuitState = (typeof CIRCUIT_STATES)[number];

/** Statuses that mean "not yet delivered, still owed to the user". */
export const PENDING_EMAIL_STATUSES: readonly EmailStatus[] = [
  'SCHEDULED',
  'QUEUED',
  'SENDING',
  'RESCHEDULED',
];

/** Statuses that mean "terminal — this job will never run again". */
export const TERMINAL_EMAIL_STATUSES: readonly EmailStatus[] = ['SENT', 'FAILED', 'CANCELLED'];
