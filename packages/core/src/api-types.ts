/**
 * API response shapes.
 *
 * The frontend imports these directly rather than redeclaring them, so a change to a
 * response shape becomes a compile error in the web app instead of a runtime surprise.
 */

import type {
  CampaignStatus,
  CircuitState,
  EmailStatus,
  PlanResult,
  WindowSummary,
} from './types.js';

// ── Envelope ──────────────────────────────────────────────────────────────────

/**
 * Every endpoint returns this envelope. A uniform shape means the typed API client
 * has exactly one error path to handle rather than one per endpoint.
 */
export type ApiResponse<T> = { ok: true; data: T } | { ok: false; error: ApiError };

export interface ApiError {
  /** Stable machine-readable code — the frontend switches on this, never on `message`. */
  code: ApiErrorCode;
  /** Safe to show a user. Never contains internal detail or stack traces. */
  message: string;
  /** Field-level validation failures, keyed by dotted field path. */
  fields?: Record<string, string[]>;
  /** Correlates a user-visible error with a server log line. */
  requestId?: string;
}

export type ApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

// ── Auth ──────────────────────────────────────────────────────────────────────

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  role: 'ADMIN' | 'MEMBER';
  tenantId: string;
  tenantName: string;
}

export interface MeResponse {
  user: SessionUser;
  slack: SlackConnectionStatus;
}

// ── Senders ───────────────────────────────────────────────────────────────────

/** Note the absence of `smtpPassword` — credentials are never serialised to the client. */
export interface SenderDto {
  id: string;
  label: string;
  fromName: string;
  fromEmail: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpSecure: boolean;
  hourlyLimit: number;
  minGapMs: number;
  isActive: boolean;
  createdAt: string;
}

export interface SenderHealthDto {
  senderId: string;
  label: string;
  fromEmail: string;
  isActive: boolean;

  circuitState: CircuitState;
  circuitOpenedAt: string | null;
  /** When a HALF_OPEN probe will next be allowed. Null when CLOSED. */
  retryAt: string | null;
  consecutiveFailures: number;

  /** Current wall-clock hour window. */
  windowStart: string;
  hourlyLimit: number;
  sentThisWindow: number;
  remainingThisWindow: number;

  sentTotal: number;
  failedTotal: number;
  /** 0–1, over the recent rolling sample. */
  recentFailureRate: number;

  /** `remainingThisWindow × (1 − recentFailureRate)`; 0 when the circuit is open. */
  healthScore: number;
  /** True when this sender is currently eligible to receive rerouted traffic. */
  eligible: boolean;
}

// ── Campaigns ─────────────────────────────────────────────────────────────────

export interface CampaignDto {
  id: string;
  name: string;
  subject: string;
  status: CampaignStatus;
  startAt: string;
  minGapMs: number;
  hourlyLimitPerSender: number;

  totalRecipients: number;
  plannedWindows: number;
  plannedFinishAt: string;

  /** Live counters, recomputed per request. */
  counts: CampaignCounts;

  createdAt: string;
  createdByName: string;
}

export interface CampaignCounts {
  scheduled: number;
  queued: number;
  sending: number;
  sent: number;
  failed: number;
  cancelled: number;
  rescheduled: number;
  total: number;
}

export interface CampaignDetailDto extends CampaignDto {
  body: string;
  /** The plan as computed at schedule time — lets the UI show forecast vs actual. */
  plannedWindowSummary: WindowSummary[];
}

// ── Emails ────────────────────────────────────────────────────────────────────

export interface EmailJobDto {
  id: string;
  recipientEmail: string;
  subject: string;
  status: EmailStatus;

  scheduledAt: string;
  sentAt: string | null;
  failedAt: string | null;

  campaignId: string;
  campaignName: string;

  plannedSenderId: string;
  plannedSenderLabel: string;
  /** Differs from planned when the circuit breaker rerouted this send. */
  actualSenderId: string | null;
  actualSenderLabel: string | null;

  attempts: number;
  lastError: string | null;
  /** Ethereal preview link — the proof the mail was really sent. */
  previewUrl: string | null;
  /** How many times a rate limit pushed this into a later window. */
  rescheduleCount: number;
}

// ── Planning ──────────────────────────────────────────────────────────────────

/** `POST /api/campaigns/preview` response. Confirms the browser's local forecast
 *  against the authoritative sender list. */
export interface PlanPreviewResponse {
  plan: Omit<PlanResult, 'jobs'>;
  /** Present when the client's own forecast disagreed — should never happen, and is
   *  logged server-side if it does. Surfaced so drift is visible rather than silent. */
  clientDriftDetected?: boolean;
}

// ── Slack ─────────────────────────────────────────────────────────────────────

export interface SlackConnectionStatus {
  connected: boolean;
  teamName: string | null;
  channelName: string | null;
  connectedAt: string | null;
}

// ── Dashboard stats ───────────────────────────────────────────────────────────

export interface DashboardStatsDto {
  scheduledCount: number;
  sentCount: number;
  failedCount: number;
  sentLastHour: number;
  activeCampaigns: number;
  activeSenders: number;
  openCircuits: number;
  /** Next send due, across all campaigns. */
  nextSendAt: string | null;
}

// ── Search ────────────────────────────────────────────────────────────────────

export interface SearchHitDto extends EmailJobDto {
  /** Elasticsearch relevance score. Null when the Postgres fallback served the query. */
  score: number | null;
  /** Highlighted fragments, keyed by field. */
  highlights?: Record<string, string[]>;
}

export interface SearchResponse extends Paginated<SearchHitDto> {
  /** Tells the UI to show a "search running in degraded mode" hint. */
  backend: 'elasticsearch' | 'postgres-fallback';
  tookMs: number;
}
