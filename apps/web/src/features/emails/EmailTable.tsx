/**
 * Email tables — Scheduled and Sent.
 *
 * ONE COMPONENT, TWO VIEWS.
 *
 * The brief asks for a Scheduled table (email / subject / scheduled time / status)
 * and a Sent table (email / subject / sent time / status). They differ only in which
 * time column they show, how they sort, and their empty-state copy. Building two
 * near-identical components would be exactly the duplication the brief's "DRY code"
 * requirement is asking us not to write.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { EmailJobDto } from '@throttle/core';
import { api } from '../../lib/api';
import { formatDateTime, formatRelative } from '../../lib/utils';
import {
  Badge,
  EmptyState,
  ErrorState,
  Pagination,
  StatusBadge,
  Table,
  TableSkeleton,
  Td,
  Th,
} from '../../components/ui';

export type EmailBucket = 'scheduled' | 'sent';

interface EmailTableProps {
  bucket: EmailBucket;
  /** Optional search term — switches to the Elasticsearch-backed endpoint. */
  search?: string;
  onCompose?: () => void;
}

const PAGE_SIZE = 25;

export function EmailTable({ bucket, search, onCompose }: EmailTableProps) {
  const [page, setPage] = useState(1);
  const isSearching = Boolean(search && search.trim().length > 0);

  const query = useQuery({
    queryKey: ['emails', bucket, page, search ?? ''],
    queryFn: () =>
      isSearching
        ? api.emails.search({ q: search!.trim(), page, pageSize: PAGE_SIZE })
        : api.emails.list({ bucket, page, pageSize: PAGE_SIZE }),
    // Scheduled emails change as the worker drains them, so poll while that tab is
    // open. Sent history is far less volatile.
    refetchInterval: bucket === 'scheduled' && !isSearching ? 10_000 : false,
    placeholderData: (previous) => previous,
  });

  if (query.isLoading) {
    return <TableSkeleton rows={6} columns={5} />;
  }

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
    return isSearching ? (
      <EmptyState
        icon={<SearchIcon />}
        title="No matching emails"
        description={`Nothing matched “${search}”. Try a different address, subject or campaign name.`}
      />
    ) : bucket === 'scheduled' ? (
      <EmptyState
        icon={<ClockIcon />}
        title="No scheduled emails"
        description="Compose a campaign to queue your first batch. You'll see the delivery forecast before anything sends."
        {...(onCompose
          ? {
              action: (
                <button
                  onClick={onCompose}
                  className="text-sm font-medium text-brand-hover hover:underline"
                >
                  Compose new email
                </button>
              ),
            }
          : {})}
      />
    ) : (
      <EmptyState
        icon={<SendIcon />}
        title="Nothing sent yet"
        description="Once your scheduled emails start going out, they'll appear here with a preview link for each one."
      />
    );
  }

  return (
    <>
      {/* Honest about degraded search rather than silently returning worse results. */}
      {backend === 'postgres-fallback' && isSearching ? (
        <div className="border-b border-line bg-warning/5 px-5 py-2">
          <p className="text-xs text-warning">
            Elasticsearch is unavailable — showing basic database search. Results are
            unranked and not highlighted.
          </p>
        </div>
      ) : null}

      <Table>
        <thead>
          <tr>
            <Th>Email</Th>
            <Th>Subject</Th>
            <Th>{bucket === 'sent' ? 'Sent' : 'Scheduled'}</Th>
            <Th>Sender</Th>
            <Th align="right">Status</Th>
          </tr>
        </thead>
        <tbody>
          {items.map((email) => (
            <EmailRow key={email.id} email={email} bucket={bucket} />
          ))}
        </tbody>
      </Table>

      <Pagination
        page={page}
        totalPages={query.data?.totalPages ?? 1}
        total={query.data?.total ?? 0}
        onPageChange={setPage}
      />
    </>
  );
}

function EmailRow({ email, bucket }: { email: EmailJobDto; bucket: EmailBucket }) {
  const timestamp = bucket === 'sent' ? (email.sentAt ?? email.failedAt) : email.scheduledAt;
  const wasRerouted =
    email.actualSenderId !== null && email.actualSenderId !== email.plannedSenderId;

  return (
    <tr className="transition-colors hover:bg-surface-2/40">
      <Td className="font-medium text-ink">
        <span className="block max-w-[22ch] truncate" title={email.recipientEmail}>
          {email.recipientEmail}
        </span>
      </Td>

      <Td>
        <span className="block max-w-[28ch] truncate" title={email.subject}>
          {email.subject}
        </span>
        <span className="block max-w-[28ch] truncate text-xs text-ink-muted" title={email.campaignName}>
          {email.campaignName}
        </span>
      </Td>

      <Td>
        <span className="block whitespace-nowrap">{formatDateTime(timestamp)}</span>
        <span className="block text-xs text-ink-muted">{formatRelative(timestamp)}</span>
      </Td>

      <Td>
        <span className="block whitespace-nowrap">
          {email.actualSenderLabel ?? email.plannedSenderLabel}
        </span>
        {/* Surfacing the reroute is the circuit breaker made visible — otherwise its
            most important behaviour is invisible in the UI. */}
        {wasRerouted ? (
          <Badge tone="warning" className="mt-0.5">
            rerouted from {email.plannedSenderLabel}
          </Badge>
        ) : null}
      </Td>

      <Td align="right">
        <div className="flex flex-col items-end gap-1">
          <StatusBadge status={email.status} />

          {email.rescheduleCount > 0 ? (
            <span className="text-xs text-ink-muted">
              deferred {email.rescheduleCount}×
            </span>
          ) : null}

          {/* The demonstrable proof a send really happened. */}
          {email.previewUrl ? (
            <a
              href={email.previewUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs font-medium text-brand-hover hover:underline"
            >
              View email ↗
            </a>
          ) : null}

          {email.lastError && email.status === 'FAILED' ? (
            <span
              className="max-w-[24ch] truncate text-xs text-critical"
              title={email.lastError}
            >
              {email.lastError}
            </span>
          ) : null}
        </div>
      </Td>
    </tr>
  );
}

// ── Icons ─────────────────────────────────────────────────────────────────────

const iconProps = {
  className: 'size-8',
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
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
      <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" strokeLinecap="round" strokeLinejoin="round" />
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
