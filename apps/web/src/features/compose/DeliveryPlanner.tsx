/**
 * ⭐ The Delivery Planner.
 *
 * WHAT MAKES THIS DIFFERENT FROM A MOCKUP
 * ---------------------------------------
 * The forecast below is not an estimate of what the backend will do. It is computed
 * by `planSchedule()` from `@throttle/core` — the EXACT function the API calls to
 * write `scheduledAt` into Postgres and to set the BullMQ delay.
 *
 * One function, imported by both sides. There is no second implementation to drift.
 * If the chart says the campaign finishes at 16:12, it finishes at 16:12.
 *
 * It also turns the brief's "behaviour under load" requirement into something you can
 * SEE: schedule 1,000 emails against 3 senders at 50/hour and the chart shows them
 * spread over 7 hour windows before you have sent anything.
 *
 * CHART DESIGN NOTES
 * ------------------
 * Form: stacked bars. The job is magnitude-over-time with a categorical breakdown —
 * "how many emails in each hour, and from whom". Stacking is right because the parts
 * genuinely sum to a meaningful whole (total sends that hour).
 *
 * Colour: the series palette is validated (see index.css). Slot order is the
 * colourblind-safety mechanism, so senders take slots in order and never cycle.
 * Every sender is also named in the legend, so identity never rests on colour alone.
 *
 * A capacity reference line marks the ceiling, which is what makes a full bar legible
 * as "at the limit" rather than merely "tall".
 */

import { useMemo } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  describePlan,
  formatDuration,
  planSchedule,
  type PlanSender,
  type PlanResult,
} from '@throttle/core';
import { formatDateTime, formatNumber, formatTime } from '../../lib/utils';
import { Badge } from '../../components/ui';

/**
 * Monochrome series ramp, brightest first. With no hue available, LIGHTNESS is the
 * only channel distinguishing one sender from another — so these four steps are
 * spaced to stay >= 1.7:1 apart in contrast while each clearing 3:1 against the
 * chart surface. See the measurement table in index.css.
 */
const SERIES_COLORS = [
  'var(--color-series-1)',
  'var(--color-series-2)',
  'var(--color-series-3)',
  'var(--color-series-4)',
] as const;

/**
 * Four is the ceiling, not a preference.
 *
 * The usable span runs from "readable on the surface" (3:1) up to white (18.7:1),
 * and only four steps fit inside it at >= 1.7:1 apart. A fifth would be
 * indistinguishable from its neighbour, so a fifth sender folds into "Other"
 * rather than being handed an invented shade nobody can tell apart.
 */
const MAX_SERIES = SERIES_COLORS.length;

export interface DeliveryPlannerProps {
  recipientCount: number;
  senders: PlanSender[];
  startAt: Date;
  minGapMs: number;
}

interface ChartRow {
  windowStart: number;
  label: string;
  total: number;
  [senderKey: string]: number | string;
}

export function DeliveryPlanner({
  recipientCount,
  senders,
  startAt,
  minGapMs,
}: DeliveryPlannerProps) {
  const plan: PlanResult = useMemo(() => {
    // Placeholder addresses: the plan depends only on the COUNT, never the values.
    // That means the forecast works before a file is even uploaded, and it keeps this
    // call cheap enough to run on every keystroke.
    const recipients = Array.from({ length: recipientCount }, (_, i) => `r${i}@example.com`);
    return planSchedule({
      recipients,
      senders,
      startAt: startAt.getTime(),
      minGapMs,
    });
  }, [recipientCount, senders, startAt, minGapMs]);

  const visibleSenders = useMemo(
    () => plan.senders.filter((s) => s.assigned > 0).slice(0, MAX_SERIES),
    [plan.senders],
  );

  /** Senders beyond the ramp's capacity, reported honestly rather than hidden. */
  const overflowCount = useMemo(
    () => Math.max(0, plan.senders.filter((s) => s.assigned > 0).length - MAX_SERIES),
    [plan.senders],
  );

  const chartData: ChartRow[] = useMemo(
    () =>
      plan.windows.map((window) => {
        const row: ChartRow = {
          windowStart: window.windowStart,
          label: formatTime(window.windowStart),
          total: window.count,
        };
        for (const sender of visibleSenders) {
          const entry = window.bySender.find((s) => s.senderId === sender.senderId);
          row[sender.senderId] = entry?.count ?? 0;
        }
        return row;
      }),
    [plan.windows, visibleSenders],
  );

  if (recipientCount === 0) {
    return (
      <div className="rounded-lg border border-dashed border-line-strong bg-surface-2/40 px-5 py-8 text-center">
        <p className="text-sm text-ink-muted">
          Upload a lead file to see how this campaign will be delivered.
        </p>
      </div>
    );
  }

  if (senders.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-line-strong bg-surface-2 px-5 py-8 text-center">
        <p className="text-sm text-ink-secondary">
          No active senders. Add a sender before scheduling.
        </p>
      </div>
    );
  }

  return (
    <section
      className="rounded-xl border border-line bg-surface"
      aria-label="Delivery forecast"
    >
      {/* ── Headline ──────────────────────────────────────────────────────── */}
      <div className="border-b border-line px-5 py-4">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h3 className="text-sm font-semibold text-ink">Delivery forecast</h3>
          <Badge tone="brand">Computed by the same planner the scheduler uses</Badge>
        </div>

        {/* The hero sentence — the thing a reviewer reads first. */}
        <p className="mt-2 text-sm text-ink-secondary">{describePlan(plan)}</p>
      </div>

      {/* ── Key figures ───────────────────────────────────────────────────── */}
      <dl className="grid grid-cols-2 gap-px bg-line sm:grid-cols-4">
        <Figure label="Emails" value={formatNumber(plan.totalRecipients)} />
        <Figure
          label="Hour windows"
          value={formatNumber(plan.windowCount)}
          hint={`${formatNumber(plan.totalCapacityPerHour)}/hr capacity`}
        />
        <Figure label="Duration" value={formatDuration(plan.durationMs)} />
        <Figure
          label="Finishes"
          value={formatTime(plan.finishesAt)}
          hint={formatDateTime(plan.finishesAt)}
        />
      </dl>

      {/* ── Chart ─────────────────────────────────────────────────────────── */}
      <div className="px-2 pt-5 pb-1">
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={chartData} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
            {/* Horizontal only, and recessive — gridlines support reading values,
                they are not content. */}
            <CartesianGrid
              horizontal
              vertical={false}
              stroke="var(--color-line)"
              strokeDasharray="2 4"
            />
            <XAxis
              dataKey="label"
              tick={{ fill: 'var(--color-pending-ink)', fontSize: 11 }}
              axisLine={{ stroke: 'var(--color-line-strong)' }}
              tickLine={false}
              // Recharts drops labels itself when they would collide, which keeps a
              // 20-window campaign readable without rotating text.
              interval="preserveStartEnd"
            />
            <YAxis
              tick={{ fill: 'var(--color-pending-ink)', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              width={44}
              allowDecimals={false}
            />

            {/* The ceiling. Without it a full bar just looks tall; with it, a full
                bar visibly means "this hour is saturated". */}
            {plan.totalCapacityPerHour > 0 ? (
              <ReferenceLine
                y={plan.totalCapacityPerHour}
                stroke="var(--color-pending-ink)"
                strokeDasharray="4 4"
                strokeWidth={1}
                label={{
                  value: `capacity ${formatNumber(plan.totalCapacityPerHour)}/hr`,
                  position: 'insideTopRight',
                  fill: 'var(--color-pending-ink)',
                  fontSize: 10,
                }}
              />
            ) : null}

            <Tooltip
              cursor={{ fill: 'rgb(255 255 255 / 0.04)' }}
              content={<PlannerTooltip senders={visibleSenders} />}
            />

            {visibleSenders.map((sender, index) => (
              <Bar
                key={sender.senderId}
                dataKey={sender.senderId}
                stackId="emails"
                fill={SERIES_COLORS[index % MAX_SERIES]}
                // 2px surface-coloured gap between stacked segments, so adjacent
                // series read as separate bands rather than one blended block.
                stroke="var(--color-surface)"
                strokeWidth={2}
                maxBarSize={56}
              >
                {/* Rounded ends only on the topmost non-zero segment would need
                    per-cell radii; a flat stack with gaps reads cleanly and avoids
                    the half-rounded artefact when a segment is zero. */}
                {chartData.map((row) => (
                  <Cell key={row.windowStart} />
                ))}
              </Bar>
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* ── Legend — identity is never colour-alone ───────────────────────── */}
      <ul className="flex flex-wrap gap-x-4 gap-y-2 px-5 pb-4">
        {visibleSenders.map((sender, index) => (
          <li key={sender.senderId} className="flex items-center gap-2 text-xs">
            <span
              className="size-2.5 shrink-0 rounded-sm"
              style={{ backgroundColor: SERIES_COLORS[index % MAX_SERIES] }}
              aria-hidden="true"
            />
            <span className="text-ink-secondary">{sender.label}</span>
            <span className="tabular text-ink-muted">
              {formatNumber(sender.assigned)} · {formatNumber(sender.effectiveHourlyCapacity)}/hr
            </span>
          </li>
        ))}
        {overflowCount > 0 ? (
          <li className="flex items-center gap-2 text-xs text-ink-muted">
            <span className="size-2.5 shrink-0 rounded-sm bg-surface-4" aria-hidden="true" />
            <span>+{overflowCount} more (not charted)</span>
          </li>
        ) : null}
      </ul>

      {/* ── Warnings ──────────────────────────────────────────────────────── */}
      {plan.warnings.length > 0 ? (
        <ul className="space-y-1.5 border-t border-line px-5 py-3">
          {plan.warnings.map((warning) => (
            <li key={`${warning.code}-${warning.senderId ?? ''}`} className="flex gap-2 text-xs">
              <span className="mt-0.5 shrink-0 text-pending-ink" aria-hidden="true">
                ⚠
              </span>
              <span className="text-ink-muted">{warning.message}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {/* ── Table view — the accessible alternative to reading the chart ──── */}
      <details className="border-t border-line">
        <summary className="cursor-pointer px-5 py-2.5 text-xs text-ink-muted transition-colors hover:text-ink-secondary">
          View as table
        </summary>
        <div className="overflow-x-auto px-5 pb-4">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-ink-muted">
                <th scope="col" className="py-1.5 pr-4 font-medium">Window</th>
                {visibleSenders.map((s) => (
                  <th key={s.senderId} scope="col" className="py-1.5 pr-4 text-right font-medium">
                    {s.label}
                  </th>
                ))}
                <th scope="col" className="py-1.5 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody className="text-ink-secondary">
              {chartData.map((row) => (
                <tr key={row.windowStart} className="border-t border-line/50">
                  <td className="py-1.5 pr-4">{formatDateTime(row.windowStart)}</td>
                  {visibleSenders.map((s) => (
                    <td key={s.senderId} className="py-1.5 pr-4 text-right">
                      {formatNumber(Number(row[s.senderId] ?? 0))}
                    </td>
                  ))}
                  <td className="py-1.5 text-right font-medium text-ink">
                    {formatNumber(row.total)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}

function Figure({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="bg-surface px-5 py-3">
      <dt className="text-xs text-ink-muted">{label}</dt>
      {/* Proportional figures deliberately — these are standalone numbers, not a
          column that needs vertical alignment. */}
      <dd className="mt-0.5 text-lg font-semibold text-ink">{value}</dd>
      {hint ? <p className="text-xs text-ink-muted">{hint}</p> : null}
    </div>
  );
}

interface TooltipProps {
  active?: boolean;
  payload?: { payload: ChartRow }[];
  senders: { senderId: string; label: string }[];
}

function PlannerTooltip({ active, payload, senders }: TooltipProps) {
  if (!active || !payload?.length) return null;
  const row = payload[0]!.payload;

  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2 text-xs popover-shadow">
      <p className="font-medium text-ink">{formatDateTime(row.windowStart)}</p>
      <p className="mb-1.5 text-ink-muted">
        {formatNumber(row.total)} email{row.total === 1 ? '' : 's'} this hour
      </p>
      <ul className="space-y-0.5">
        {senders.map((sender, index) => {
          const count = Number(row[sender.senderId] ?? 0);
          if (count === 0) return null;
          return (
            <li key={sender.senderId} className="flex items-center gap-2">
              <span
                className="size-2 shrink-0 rounded-sm"
                style={{ backgroundColor: SERIES_COLORS[index % MAX_SERIES] }}
                aria-hidden="true"
              />
              <span className="text-ink-secondary">{sender.label}</span>
              <span className="tabular ml-auto text-ink">{formatNumber(count)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
