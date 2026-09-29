/**
 * The Delivery Planner.
 *
 * `planSchedule()` is the single source of truth for *when every email goes out*.
 * It is imported by:
 *   - `apps/api`  → to compute the real `scheduledAt` written to Postgres and the
 *                   real `delay` handed to BullMQ
 *   - `apps/web`  → to render the live forecast in the compose form
 *
 * Because it is the same function on both sides, the forecast the user sees before
 * clicking Schedule is not an approximation of what will happen — it IS what will
 * happen. That is the entire point of the feature.
 *
 * PURITY CONTRACT (do not break this)
 * -----------------------------------
 *   - No `Date.now()`. The caller passes `startAt`.
 *   - No `Math.random()`.
 *   - No I/O, no logging, no throwing on soft problems (use `warnings`).
 * Violating any of these desynchronises the forecast from reality.
 *
 * SCHEDULING MODEL
 * ----------------
 * Recipients are dealt round-robin across senders (balancing load and keeping each
 * sender's slice in submission order). Each sender then walks a time cursor forward:
 * it places a send, advances by its effective gap, and rolls into the next wall-clock
 * hour window whenever it exhausts that window's quota or runs out of wall time.
 *
 * Two ceilings apply per sender per window, and the tighter one wins:
 *   1. the configured `hourlyLimit`
 *   2. the gap-imposed cap — with a 2s gap you physically cannot exceed 1800/hour
 * Surfacing (2) as a warning is useful: it tells a user asking for 3000/hr with a 2s
 * gap that their limit is unreachable, before they schedule anything.
 */

import {
  HOUR_MS,
  formatDuration,
  gapImposedHourlyCap,
  hourWindowEnd,
  hourWindowStart,
} from './time.js';
import type {
  PlanInput,
  PlanResult,
  PlanSender,
  PlanWarning,
  PlannedJob,
  SenderPlanSummary,
  WindowSummary,
} from './types.js';

/** Beyond this many windows we warn — a campaign spanning days is usually a mistake. */
const LONG_CAMPAIGN_WINDOW_THRESHOLD = 24;

/** Safety valve: stop planning rather than hang if inputs are pathological. */
const MAX_PLANNING_ITERATIONS = 5_000_000;

interface ResolvedSender extends PlanSender {
  effectiveGapMs: number;
  effectiveHourlyCapacity: number;
}

/**
 * Resolve each sender's real operating parameters by combining its own settings
 * with the campaign-level floor.
 */
function resolveSenders(senders: PlanSender[], campaignMinGapMs: number): ResolvedSender[] {
  return senders.map((sender) => {
    // The campaign floor can only make spacing wider, never tighter — a sender that
    // declares it needs 5s between sends must never be driven at 2s.
    const effectiveGapMs = Math.max(0, campaignMinGapMs, sender.minGapMs);
    const effectiveHourlyCapacity = Math.max(
      0,
      Math.min(sender.hourlyLimit, gapImposedHourlyCap(effectiveGapMs)),
    );
    return { ...sender, effectiveGapMs, effectiveHourlyCapacity };
  });
}

/**
 * Deal recipients round-robin across senders.
 *
 * Round-robin (rather than contiguous chunks) matters because it keeps every sender
 * busy from the first window. Chunking would have sender A send its whole allocation
 * before sender B starts, which wastes parallel capacity and produces a forecast that
 * looks nothing like the balanced reality the worker produces.
 */
function assignRoundRobin(
  recipients: string[],
  senders: ResolvedSender[],
): Map<string, { recipient: string; sequenceNo: number }[]> {
  const buckets = new Map<string, { recipient: string; sequenceNo: number }[]>();
  for (const sender of senders) buckets.set(sender.id, []);

  // Senders with zero capacity are skipped entirely — dealing to them would strand
  // recipients in a bucket that never drains.
  const usable = senders.filter((s) => s.effectiveHourlyCapacity > 0);
  if (usable.length === 0) return buckets;

  recipients.forEach((recipient, index) => {
    const sender = usable[index % usable.length]!;
    buckets.get(sender.id)!.push({ recipient, sequenceNo: index });
  });

  return buckets;
}

/**
 * Walk one sender's assigned recipients forward in time, respecting its gap and its
 * per-window quota.
 *
 * The cursor approach handles three things that a naive `index / capacity` formula
 * gets wrong:
 *   - a partial first window (campaign starting at 10:45 has 15 min of the 10:00 hour)
 *   - the gap running out of wall time before the quota is exhausted
 *   - quota exhaustion mid-window, requiring a jump to the next window boundary
 */
function scheduleForSender(
  sender: ResolvedSender,
  assignments: { recipient: string; sequenceNo: number }[],
  startAt: number,
): PlannedJob[] {
  const jobs: PlannedJob[] = [];
  if (assignments.length === 0 || sender.effectiveHourlyCapacity <= 0) return jobs;

  /** How many sends this sender has already placed in each window. */
  const windowUsage = new Map<number, number>();
  let cursor = startAt;
  let iterations = 0;

  for (const { recipient, sequenceNo } of assignments) {
    // Advance the cursor until it lands on a moment that has both quota and wall time.
    for (;;) {
      if (++iterations > MAX_PLANNING_ITERATIONS) return jobs;

      const windowStart = hourWindowStart(cursor);
      const used = windowUsage.get(windowStart) ?? 0;

      if (used >= sender.effectiveHourlyCapacity) {
        // Quota for this window is spent — jump to the top of the next one.
        cursor = hourWindowEnd(cursor);
        continue;
      }
      break;
    }

    const windowStart = hourWindowStart(cursor);
    const used = windowUsage.get(windowStart) ?? 0;

    jobs.push({
      sequenceNo,
      recipient,
      senderId: sender.id,
      scheduledAt: cursor,
      windowStart,
      slotInWindow: used,
    });

    windowUsage.set(windowStart, used + 1);
    cursor += sender.effectiveGapMs;
  }

  return jobs;
}

/** Roll the per-sender job lists up into the per-window summaries the bar chart needs. */
function summariseWindows(
  jobs: PlannedJob[],
  senders: ResolvedSender[],
): WindowSummary[] {
  const labelById = new Map(senders.map((s) => [s.id, s.label]));
  const byWindow = new Map<number, Map<string, number>>();

  for (const job of jobs) {
    let senderCounts = byWindow.get(job.windowStart);
    if (!senderCounts) {
      senderCounts = new Map<string, number>();
      byWindow.set(job.windowStart, senderCounts);
    }
    senderCounts.set(job.senderId, (senderCounts.get(job.senderId) ?? 0) + 1);
  }

  const totalCapacity = senders.reduce((sum, s) => sum + s.effectiveHourlyCapacity, 0);

  return [...byWindow.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([windowStart, senderCounts]) => {
      const bySender = [...senderCounts.entries()]
        .map(([senderId, count]) => ({
          senderId,
          label: labelById.get(senderId) ?? senderId,
          count,
        }))
        .sort((a, b) => b.count - a.count);

      return {
        windowStart,
        windowEnd: windowStart + HOUR_MS,
        count: bySender.reduce((sum, s) => sum + s.count, 0),
        bySender,
        capacity: totalCapacity,
      };
    });
}

function buildWarnings(
  senders: ResolvedSender[],
  windowCount: number,
  startAt: number,
): PlanWarning[] {
  const warnings: PlanWarning[] = [];

  for (const sender of senders) {
    const gapCap = gapImposedHourlyCap(sender.effectiveGapMs);
    if (Number.isFinite(gapCap) && gapCap < sender.hourlyLimit) {
      warnings.push({
        code: 'GAP_CAPS_HOURLY_LIMIT',
        senderId: sender.id,
        message:
          `${sender.label}: a ${formatDuration(sender.effectiveGapMs)} gap caps this sender at ` +
          `${gapCap}/hour, so the configured limit of ${sender.hourlyLimit}/hour is unreachable. ` +
          `Lower the gap or the limit to remove the ambiguity.`,
      });
    }
  }

  if (senders.length === 1) {
    warnings.push({
      code: 'SINGLE_SENDER_NO_FAILOVER',
      message:
        'Only one sender is active. If its circuit breaker opens there is nowhere to ' +
        'reroute traffic, and the campaign will stall until it recovers.',
    });
  }

  if (windowCount > LONG_CAMPAIGN_WINDOW_THRESHOLD) {
    warnings.push({
      code: 'LONG_RUNNING_CAMPAIGN',
      message:
        `This campaign spans ${windowCount} hour windows (more than a day). Add senders or ` +
        `raise hourly limits to finish sooner.`,
    });
  }

  // A partial first window is normal, but worth surfacing because it explains why the
  // first bar in the chart is shorter than the rest.
  const firstWindowStart = hourWindowStart(startAt);
  if (startAt > firstWindowStart) {
    const remaining = hourWindowEnd(startAt) - startAt;
    warnings.push({
      code: 'PARTIAL_FIRST_WINDOW',
      message:
        `The campaign starts mid-window, leaving ${formatDuration(remaining)} of the first ` +
        `hour. The first window therefore carries fewer emails than later ones.`,
    });
  }

  return warnings;
}

/**
 * Produce a complete, deterministic delivery plan.
 *
 * Never throws on soft problems — an empty sender list or empty recipient list yields
 * an empty plan with warnings, because this runs on every keystroke in the compose form
 * and a throw would blank the UI mid-typing.
 */
export function planSchedule(input: PlanInput): PlanResult {
  const { recipients, startAt, minGapMs } = input;

  const senders = resolveSenders(input.senders, minGapMs);
  const buckets = assignRoundRobin(recipients, senders);

  const jobs: PlannedJob[] = [];
  for (const sender of senders) {
    const assignments = buckets.get(sender.id) ?? [];
    jobs.push(...scheduleForSender(sender, assignments, startAt));
  }

  // Order the final plan the way it will actually execute: by time, with submission
  // order breaking ties between senders firing in the same millisecond.
  jobs.sort((a, b) => a.scheduledAt - b.scheduledAt || a.sequenceNo - b.sequenceNo);

  const windows = summariseWindows(jobs, senders);

  const senderSummaries: SenderPlanSummary[] = senders.map((sender) => {
    const own = jobs.filter((j) => j.senderId === sender.id);
    return {
      senderId: sender.id,
      label: sender.label,
      assigned: own.length,
      effectiveGapMs: sender.effectiveGapMs,
      effectiveHourlyCapacity: sender.effectiveHourlyCapacity,
      firstSendAt: own.length > 0 ? own[0]!.scheduledAt : null,
      lastSendAt: own.length > 0 ? own[own.length - 1]!.scheduledAt : null,
    };
  });

  const finishesAt = jobs.length > 0 ? jobs[jobs.length - 1]!.scheduledAt : startAt;
  const totalCapacityPerHour = senders.reduce((sum, s) => sum + s.effectiveHourlyCapacity, 0);

  return {
    jobs,
    windows,
    senders: senderSummaries,
    startsAt: startAt,
    finishesAt,
    windowCount: windows.length,
    totalRecipients: recipients.length,
    totalCapacityPerHour,
    durationMs: finishesAt - startAt,
    warnings: buildWarnings(senders, windows.length, startAt),
  };
}

/**
 * One-line human summary of a plan, e.g.
 * "1,000 emails · 3 senders · 150/hour · 7 windows · finishes in 6h 40m"
 *
 * Used for the headline above the bar chart and in the Slack notification body.
 */
export function describePlan(plan: PlanResult): string {
  if (plan.totalRecipients === 0) return 'Nothing to schedule yet.';

  const parts = [
    `${plan.totalRecipients.toLocaleString()} email${plan.totalRecipients === 1 ? '' : 's'}`,
    `${plan.senders.length} sender${plan.senders.length === 1 ? '' : 's'}`,
    `${plan.totalCapacityPerHour.toLocaleString()}/hour`,
    `${plan.windowCount} window${plan.windowCount === 1 ? '' : 's'}`,
    `finishes in ${formatDuration(plan.durationMs)}`,
  ];
  return parts.join(' · ');
}
