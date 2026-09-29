/**
 * Typed API client.
 *
 * Every response type is imported from `@throttle/core` rather than redeclared, so a
 * change to a backend response shape becomes a COMPILE ERROR here instead of an
 * `undefined` at runtime. That is the main reason the monorepo exists.
 *
 * THREE THINGS THIS LAYER HANDLES ONCE, SO NO COMPONENT HAS TO
 * ------------------------------------------------------------
 *   1. `credentials: 'include'` — sessions are httpOnly cookies, which fetch() does
 *      NOT send cross-origin unless explicitly told to.
 *   2. The CSRF header — read from the readable CSRF cookie and echoed on every
 *      mutating request (the double-submit pattern the API enforces).
 *   3. Transparent token refresh — a 401 triggers one refresh attempt and one retry.
 *      Without this, every user is silently logged out 15 minutes after signing in.
 */

import type {
  ApiError,
  ApiResponse,
  CampaignDetailDto,
  CampaignDto,
  DashboardStatsDto,
  EmailJobDto,
  MeResponse,
  Paginated,
  ParsedLeads,
  PlanPreviewResponse,
  SearchResponse,
  SenderDto,
  SenderHealthDto,
  SlackConnectionStatus,
} from '@throttle/core';

const API_URL = import.meta.env['VITE_API_URL'] ?? 'http://localhost:4000';

const CSRF_COOKIE = 'throttle_csrf';
const CSRF_HEADER = 'x-csrf-token';

/** Thrown by every client method on a non-OK response. */
export class ApiRequestError extends Error {
  readonly code: ApiError['code'];
  readonly fields: Record<string, string[]> | undefined;
  readonly status: number;
  readonly requestId: string | undefined;

  constructor(status: number, error: ApiError) {
    super(error.message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = error.code;
    this.fields = error.fields;
    this.requestId = error.requestId;
  }

  /** True when the user should be sent back to the login screen. */
  get isAuthError(): boolean {
    return this.code === 'UNAUTHENTICATED';
  }
}

function readCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** Internal: prevents infinite recursion when the refresh call itself 401s. */
  _isRetry?: boolean;
}

/**
 * Single-flight refresh.
 *
 * If three requests 401 simultaneously, they must not fire three refresh calls —
 * refresh tokens ROTATE, so the second and third would present an already-rotated
 * token, which the server correctly treats as token theft and responds to by
 * revoking the entire family. The user gets logged out by their own app.
 *
 * Sharing one in-flight promise makes concurrent 401s wait on a single refresh.
 */
let refreshPromise: Promise<boolean> | null = null;

async function refreshSession(): Promise<boolean> {
  refreshPromise ??= (async () => {
    try {
      const response = await fetch(`${API_URL}/api/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { [CSRF_HEADER]: readCookie(CSRF_COOKIE) ?? '' },
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      // Cleared on the next tick so callers awaiting this promise all observe the
      // same result before a fresh attempt becomes possible.
      setTimeout(() => {
        refreshPromise = null;
      }, 0);
    }
  })();

  return refreshPromise;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';

  const headers = new Headers(options.headers);
  if (options.body !== undefined && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  if (!SAFE_METHODS.has(method)) {
    headers.set(CSRF_HEADER, readCookie(CSRF_COOKIE) ?? '');
  }

  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...options,
      method,
      headers,
      // Required for the httpOnly session cookies to travel cross-origin.
      credentials: 'include',
      body:
        options.body instanceof FormData
          ? options.body
          : options.body !== undefined
            ? JSON.stringify(options.body)
            : undefined,
    });
  } catch {
    // A network-level failure has no response body to parse, so it is surfaced as a
    // recognisable upstream error rather than a generic "Failed to fetch".
    throw new ApiRequestError(0, {
      code: 'UPSTREAM_UNAVAILABLE',
      message: 'Could not reach the server. Check your connection and try again.',
    });
  }

  // ── Transparent refresh ──────────────────────────────────────────────────
  if (response.status === 401 && !options._isRetry && !path.startsWith('/api/auth/')) {
    if (await refreshSession()) {
      return request<T>(path, { ...options, _isRetry: true });
    }
  }

  let payload: ApiResponse<T>;
  try {
    payload = (await response.json()) as ApiResponse<T>;
  } catch {
    throw new ApiRequestError(response.status, {
      code: response.status >= 500 ? 'INTERNAL_ERROR' : 'VALIDATION_ERROR',
      message: `Unexpected response from the server (HTTP ${response.status}).`,
    });
  }

  if (!payload.ok) throw new ApiRequestError(response.status, payload.error);
  return payload.data;
}

const buildQuery = (params: Record<string, unknown>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      search.set(key, String(value));
    }
  }
  const query = search.toString();
  return query ? `?${query}` : '';
};

// ─────────────────────────────────────────────────────────────────────────────
// API surface
// ─────────────────────────────────────────────────────────────────────────────

export const api = {
  config: () =>
    request<{ googleOAuthEnabled: boolean; slackOAuthEnabled: boolean }>('/api/config'),

  auth: {
    me: () => request<MeResponse>('/api/auth/me'),
    logout: () => request<{ loggedOut: true }>('/api/auth/logout', { method: 'POST' }),
    /** Full-page navigation, not fetch — OAuth requires a top-level redirect. */
    googleLoginUrl: (redirectTo = '/dashboard') =>
      `${API_URL}/api/auth/google?redirect=${encodeURIComponent(redirectTo)}`,
  },

  stats: {
    get: () => request<DashboardStatsDto>('/api/stats'),
  },

  senders: {
    list: () => request<SenderDto[]>('/api/senders'),
    health: () => request<SenderHealthDto[]>('/api/senders/health'),
    resetCircuit: (id: string) =>
      request<{ reset: true }>(`/api/senders/${id}/reset-circuit`, { method: 'POST' }),
  },

  campaigns: {
    list: (params: { page?: number; pageSize?: number; status?: string } = {}) =>
      request<Paginated<CampaignDto>>(`/api/campaigns${buildQuery(params)}`),

    get: (id: string) => request<CampaignDetailDto>(`/api/campaigns/${id}`),

    preview: (body: {
      recipientCount: number;
      startAt: string;
      minGapMs: number;
      hourlyLimitPerSender: number;
      senderIds?: string[];
    }) => request<PlanPreviewResponse>('/api/campaigns/preview', { method: 'POST', body }),

    create: (
      body: {
        name: string;
        subject: string;
        body: string;
        recipients: string[];
        startAt: string;
        minGapMs: number;
        hourlyLimitPerSender: number;
        senderIds?: string[];
      },
      idempotencyKey: string,
    ) =>
      request<{ campaignId: string; deduplicated: boolean }>('/api/campaigns', {
        method: 'POST',
        body,
        // Makes a retried submit safe: the server returns the original campaign
        // rather than scheduling a second one.
        headers: { 'Idempotency-Key': idempotencyKey },
      }),

    cancel: (id: string) =>
      request<{ cancelledJobs: number }>(`/api/campaigns/${id}/cancel`, { method: 'POST' }),
  },

  emails: {
    list: (params: {
      page?: number;
      pageSize?: number;
      bucket?: 'scheduled' | 'sent';
      status?: string;
      campaignId?: string;
      senderId?: string;
    }) => request<Paginated<EmailJobDto>>(`/api/emails${buildQuery(params)}`),

    search: (params: { q: string; page?: number; pageSize?: number; status?: string }) =>
      request<SearchResponse>(`/api/emails/search${buildQuery(params)}`),
  },

  leads: {
    parse: (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return request<ParsedLeads>('/api/leads/parse', { method: 'POST', body: form });
    },
  },

  slack: {
    status: () => request<SlackConnectionStatus>('/api/slack/status'),
    test: () => request<{ delivered: boolean }>('/api/slack/test', { method: 'POST' }),
    disconnect: () =>
      request<{ disconnected: true }>('/api/slack/disconnect', { method: 'POST' }),
    /** Full-page navigation — OAuth requires a top-level redirect. */
    installUrl: () => `${API_URL}/api/slack/install`,
  },
};

export { API_URL };
