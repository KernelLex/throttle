/**
 * Sender health & circuit-breaker panel.
 *
 * Shows the SAME health score the worker selects senders with — it comes from
 * `GET /api/senders/health`, which computes it via the identical
 * `computeHealthScore()` the scheduler uses. A dashboard showing a number the
 * scheduler does not actually act on would be worse than showing no number.
 *
 * Circuit state is communicated by an ICON + LABEL, with colour as reinforcement
 * only. Colour alone would be invisible to colourblind users, and this panel is
 * precisely where a user needs to notice that something is wrong.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SenderHealthDto } from '@throttle/core';
import { api } from '../../lib/api';
import { formatNumber, formatRelative } from '../../lib/utils';
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  Skeleton,
  useToast,
} from '../../components/ui';

/**
 * Circuit state is carried by the GLYPH and the LABEL. Brightness only reinforces
 * the ordering (healthy is bright, paused is dim) — nothing here requires the
 * viewer to interpret a shade.
 */
const CIRCUIT_PRESENTATION = {
  CLOSED: { icon: '●', label: 'Healthy', text: 'text-accent', bar: 'bg-accent' },
  HALF_OPEN: { icon: '◐', label: 'Probing', text: 'text-pending-ink', bar: 'bg-pending-ink' },
  OPEN: { icon: '■', label: 'Paused', text: 'text-fail-ink', bar: 'bg-fail-ink' },
} as const;

export function SenderHealthPanel() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const query = useQuery({
    queryKey: ['senders', 'health'],
    queryFn: () => api.senders.health(),
    // Budgets and circuit states move in real time during a send run; this is the
    // panel where staleness is most misleading.
    refetchInterval: 5_000,
  });

  const resetCircuit = useMutation({
    mutationFn: (senderId: string) => api.senders.resetCircuit(senderId),
    onSuccess: () => {
      toast('success', 'Circuit reset — the sender is back in rotation.');
      void queryClient.invalidateQueries({ queryKey: ['senders'] });
    },
    onError: (error: Error) => toast('error', error.message),
  });

  return (
    <Card>
      <CardHeader
        title="Sender health"
        description="Traffic is routed by remaining budget × reliability. Open circuits are skipped."
      />

      {query.isLoading ? (
        <div className="space-y-4 p-5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-1.5 w-full" />
            </div>
          ))}
        </div>
      ) : query.isError ? (
        <ErrorState
          description="Could not load sender health."
          onRetry={() => void query.refetch()}
        />
      ) : (query.data?.length ?? 0) === 0 ? (
        <EmptyState
          title="No senders configured"
          description="Run `npm run db:seed` to provision Ethereal test senders, or add one via the API."
        />
      ) : (
        <ul className="divide-y divide-line">
          {query.data!.map((sender) => (
            <SenderRow
              key={sender.senderId}
              sender={sender}
              onReset={() => resetCircuit.mutate(sender.senderId)}
              resetting={resetCircuit.isPending && resetCircuit.variables === sender.senderId}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

function SenderRow({
  sender,
  onReset,
  resetting,
}: {
  sender: SenderHealthDto;
  onReset: () => void;
  resetting: boolean;
}) {
  const presentation = CIRCUIT_PRESENTATION[sender.circuitState];
  const usedPercent =
    sender.hourlyLimit > 0
      ? Math.min(100, (sender.sentThisWindow / sender.hourlyLimit) * 100)
      : 0;

  return (
    <li className="px-5 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {/* Icon + label carry the state; colour reinforces it. */}
            <span className={presentation.text} aria-hidden="true">
              {presentation.icon}
            </span>
            <span className="truncate text-sm font-medium text-ink">{sender.label}</span>
            <span className={`text-xs font-medium ${presentation.text}`}>
              {presentation.label}
            </span>
          </div>
          <p className="mt-0.5 truncate text-xs text-ink-muted">{sender.fromEmail}</p>
        </div>

        <div className="shrink-0 text-right">
          <p className="tabular text-sm text-ink">
            {formatNumber(sender.sentThisWindow)}
            <span className="text-ink-muted">/{formatNumber(sender.hourlyLimit)}</span>
          </p>
          <p className="text-xs text-ink-muted">this hour</p>
        </div>
      </div>

      {/* Budget meter. */}
      <div className="mt-3">
        <div
          className="h-1.5 overflow-hidden rounded-full bg-surface-4"
          role="progressbar"
          aria-valuenow={Math.round(usedPercent)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${sender.label} hourly budget used`}
        >
          <div
            className={`h-full rounded-full transition-all duration-500 ${presentation.bar}`}
            style={{ width: `${usedPercent}%` }}
          />
        </div>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-muted">
        <span>
          Score <span className="tabular text-pending-ink">{sender.healthScore.toFixed(1)}</span>
        </span>
        <span>
          Sent <span className="tabular text-pending-ink">{formatNumber(sender.sentTotal)}</span>
        </span>
        {sender.failedTotal > 0 ? (
          <span>
            Failed{' '}
            <span className="tabular text-fail-ink">{formatNumber(sender.failedTotal)}</span>
          </span>
        ) : null}
        {sender.recentFailureRate > 0 ? (
          <span>
            Failure rate{' '}
            <span className="tabular text-pending-ink">
              {(sender.recentFailureRate * 100).toFixed(0)}%
            </span>
          </span>
        ) : null}
      </div>

      {/* Explain the pause, and offer the override — waiting out a cooldown after
          fixing credentials is pure friction. */}
      {sender.circuitState === 'OPEN' ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-fail-bg px-3 py-2">
          <p className="text-xs text-fail-ink">
            Paused after {sender.consecutiveFailures} consecutive failures.
            {sender.retryAt ? ` Retrying ${formatRelative(sender.retryAt)}.` : ''}
          </p>
          <Button size="sm" variant="ghost" onClick={onReset} loading={resetting}>
            Reset now
          </Button>
        </div>
      ) : null}
    </li>
  );
}
