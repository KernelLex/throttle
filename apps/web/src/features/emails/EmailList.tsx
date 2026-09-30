/**
 * The mail list — the Figma's Gmail-shaped rows.
 *
 * ONE COMPONENT, TWO VIEWS.
 *
 * Scheduled and Sent differ only in which timestamp they show, how they sort,
 * and their empty-state copy. Two near-identical components would be exactly the
 * duplication the brief's "DRY code" requirement asks us to avoid.
 *
 * Row anatomy, left to right:
 *   To: <recipient>  ·  [time pill]  ·  Subject — preview  ·  star
 *
 * The time pill is the status: amber with a clock while a send is pending, grey
 * once it is done. Each carries a text label, so state never rests on colour.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { EmailJobDto, EmailStatus } from '@throttle/core';
import { api } from '../../lib/api';
import { cn, formatDateTime, formatMailTime } from '../../lib/utils';
import { EmptyState, ErrorState, Pagination, RowsSkeleton } from '../../components/ui';

export type MailboxView = 'scheduled' | 'sent';

interface EmailListProps {
  view: MailboxView;
  search: string;
  onCompose: () => void;
  /** Bumped by the parent to force a refetch after scheduling. */
  refreshKey?: number;
}

const PAGE_SIZE = 25;

export function EmailList({ view, search, onCompose, refreshKey = 0 }: EmailListProps) {
  const [page, setPage] = useState(1);
  const isSearching = search.trim().length > 0;

  const query = useQuery({
    queryKey: ['emails', view, page, search.trim(), refreshKey],
    queryFn: () =>
      isSearching
        ? api.emails.search({ q: search.trim(), page, pageSize: PAGE_SIZE })
        : api.emails.list({ bucket: view, page, pageSize: PAGE_SIZE }),
    // Scheduled rows change as the worker drains them. Sent history barely moves.
    refetchInterval: view === 'scheduled' && !isSearching ? 10_000 : false,
    placeholderData: (previous) => previous,
  });

  if (query.isLoading) return <RowsSkeleton rows={6} />;

  if (query.isError) {
    return (
      <ErrorState
        description={query.error instanceof Error ? query.error.message : undefined}
        onRetry={() => void query.refetch()}
      />
    );
  }

  const items = query.data?.items ?? [];
  const backend = query.data && 'backend' in query.data ? query.data.backend : null;

  if (items.length === 0) {
    if (isSearching) {
      return (
        <EmptyState
          icon={<SearchIcon />}
          title="No matching emails"
          description={`Nothing matched “${search.trim()}”. Try a different address, subject or campaign.`}
        />
      );
    }
    return view === 'scheduled' ? (
      <EmptyState
        icon={<ClockIcon />}
        title="No scheduled emails"
        description="Compose a campaign to queue your first batch. You'll see the delivery forecast before anything sends."
        action={
          <button
            onClick={onCompose}
            className="h-10 rounded-pill border border-accent px-5 text-sm font-medium text-accent transition-colors hover:bg-accent-tint"
          >
            Compose
          </button>
        }
      />
    ) : (
      <EmptyState
        icon={<SendIcon />}
        title="Nothing sent yet"
        description="Once your scheduled emails go out they'll appear here, each with a preview link to the real message."
      />
    );
  }

  return (
    <>
      {/* Honest about degraded search rather than quietly returning worse results. */}
      {backend === 'postgres-fallback' && isSearching ? (
        <div className="border-b border-line bg-surface-2 px-6 py-2">
          <p className="text-xs text-ink-secondary">
            Elasticsearch is unavailable — showing basic database search. Results are
            unranked and not highlighted.
          </p>
        </div>
      ) : null}

      <ul>
        {items.map((email) => (
          <EmailRow key={email.id} email={email} view={view} />
        ))}
      </ul>

      <Pagination
        page={page}
        totalPages={query.data?.totalPages ?? 1}
        total={query.data?.total ?? 0}
        onPageChange={setPage}
      />
    </>
  );
}

/** Pending states get the amber clock pill; terminal states get a flat label. */
const PENDING: readonly EmailStatus[] = ['SCHEDULED', 'QUEUED', 'SENDING', 'RESCHEDULED'];

function StatusPill({ email, view }: { email: EmailJobDto; view: MailboxView }) {
  const pending = PENDING.includes(email.status);
  const when = view === 'sent' ? (email.sentAt ?? email.failedAt) : email.scheduledAt;

  if (email.status === 'FAILED') {
    return (
      <span className="inline-flex shrink-0 items-center rounded-pill bg-fail-bg px-2.5 py-1 text-xs font-medium text-fail-ink">
        Failed
      </span>
    );
  }

  if (!pending) {
    return (
      <span className="inline-flex shrink-0 items-center rounded-pill bg-done-bg px-2.5 py-1 text-xs font-medium text-done-ink">
        Sent
      </span>
    );
  }

  return (
    <span
      className="inline-flex shrink-0 items-center gap-1.5 rounded-pill bg-pending-bg px-2.5 py-1 text-xs font-medium text-pending-ink"
      title={formatDateTime(when)}
    >
      <svg className="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7.5V12l3 2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="tabular">{formatMailTime(when)}</span>
    </span>
  );
}

function EmailRow({ email, view }: { email: EmailJobDto; view: MailboxView }) {
  const rerouted =
    email.actualSenderId !== null && email.actualSenderId !== email.plannedSenderId;

  return (
    <li className="group flex items-center gap-4 border-b border-line px-6 py-3.5 transition-colors hover:bg-surface-2">
      <span className="w-[230px] shrink-0 truncate text-[15px] font-medium text-ink">
        To: {email.recipientEmail}
      </span>

      <StatusPill email={email} view={view} />

      {/* Subject then preview, on one line — the Figma's single-line row. */}
      <span className="min-w-0 flex-1 truncate text-[15px]">
        <span className="font-semibold text-ink">{email.subject}</span>
        <span className="text-ink-muted"> — {email.campaignName}</span>
        {email.rescheduleCount > 0 ? (
          <span className="text-ink-muted"> · deferred {email.rescheduleCount}×</span>
        ) : null}
        {rerouted ? (
          <span className="text-ink-muted"> · rerouted to {email.actualSenderLabel}</span>
        ) : null}
        {email.lastError && email.status === 'FAILED' ? (
          <span className="text-fail-ink"> · {email.lastError}</span>
        ) : null}
      </span>

      {/* The Ethereal preview — the proof a message really went out. Replaces the
          Figma's star, which has no behaviour behind it in this product. */}
      {email.previewUrl ? (
        <a
          href={email.previewUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 text-[13px] font-medium text-accent opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
        >
          View ↗
        </a>
      ) : null}
    </li>
  );
}

// ── Icons ─────────────────────────────────────────────────────────────────────

const iconProps = {
  className: 'size-9',
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.4,
} as const;

function ClockIcon() {
  return (
    <svg {...iconProps}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg {...iconProps}>
      <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg {...iconProps}>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" strokeLinecap="round" />
    </svg>
  );
}

export { cn };
