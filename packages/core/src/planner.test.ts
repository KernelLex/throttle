import { describe, expect, it } from 'vitest';
import { HOUR_MS, hourWindowStart } from './time.js';
import { describePlan, planSchedule } from './planner.js';
import type { PlanSender } from './types.js';

/** A clean hour boundary, so tests read in whole windows: 2026-01-01T10:00:00Z */
const T0 = Date.UTC(2026, 0, 1, 10, 0, 0, 0);

function makeSenders(count: number, hourlyLimit = 50, minGapMs = 2_000): PlanSender[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `sender-${i + 1}`,
    label: `Sender ${i + 1}`,
    hourlyLimit,
    minGapMs,
  }));
}

function makeRecipients(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `lead${i + 1}@example.com`);
}

describe('planSchedule — the brief\'s own example', () => {
  // The assignment text says: "1,000 leads, 3 senders at 50/hr each, 2s gap: this runs
  // over 7 hour windows". 3 x 50 = 150/hour, 1000 / 150 = 6.67 -> 7 windows.
  const plan = planSchedule({
    recipients: makeRecipients(1_000),
    senders: makeSenders(3, 50, 2_000),
    startAt: T0,
    minGapMs: 2_000,
  });

  it('spreads 1,000 leads across exactly 7 hour windows', () => {
    expect(plan.windowCount).toBe(7);
  });

  it('plans every single recipient exactly once', () => {
    expect(plan.jobs).toHaveLength(1_000);
    expect(new Set(plan.jobs.map((j) => j.recipient)).size).toBe(1_000);
  });

  it('reports 150 emails/hour of combined capacity', () => {
    expect(plan.totalCapacityPerHour).toBe(150);
  });

  it('fills the first six windows to capacity and leaves the remainder in the seventh', () => {
    const counts = plan.windows.map((w) => w.count);
    expect(counts.slice(0, 6)).toEqual([150, 150, 150, 150, 150, 150]);
    expect(counts[6]).toBe(100);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1_000);
  });

  it('finishes inside the seventh window', () => {
    const seventhWindowStart = T0 + 6 * HOUR_MS;
    expect(plan.finishesAt).toBeGreaterThanOrEqual(seventhWindowStart);
    expect(plan.finishesAt).toBeLessThan(seventhWindowStart + HOUR_MS);
  });

  it('produces a readable one-line summary', () => {
    expect(describePlan(plan)).toContain('1,000 emails');
    expect(describePlan(plan)).toContain('3 senders');
    expect(describePlan(plan)).toContain('7 windows');
  });
});

describe('planSchedule — determinism', () => {
  it('returns byte-identical results for identical input', () => {
    // This is the property the whole Delivery Planner rests on: the browser and the
    // server must compute the same plan from the same input.
    const input = {
      recipients: makeRecipients(237),
      senders: makeSenders(4, 40, 1_500),
      startAt: T0,
      minGapMs: 3_000,
    };
    expect(JSON.stringify(planSchedule(input))).toBe(JSON.stringify(planSchedule(input)));
  });
});

describe('planSchedule — rate limits', () => {
  it('never exceeds a sender\'s hourly limit in any window', () => {
    const plan = planSchedule({
      recipients: makeRecipients(500),
      senders: makeSenders(2, 30, 1_000),
      startAt: T0,
      minGapMs: 1_000,
    });

    const perSenderPerWindow = new Map<string, number>();
    for (const job of plan.jobs) {
      const key = `${job.senderId}@${job.windowStart}`;
      perSenderPerWindow.set(key, (perSenderPerWindow.get(key) ?? 0) + 1);
    }
    for (const count of perSenderPerWindow.values()) {
      expect(count).toBeLessThanOrEqual(30);
    }
  });

  it('respects the minimum gap between consecutive sends from the same sender', () => {
    const gapMs = 5_000;
    const plan = planSchedule({
      recipients: makeRecipients(100),
      senders: makeSenders(2, 100, gapMs),
      startAt: T0,
      minGapMs: gapMs,
    });

    for (const sender of plan.senders) {
      const times = plan.jobs
        .filter((j) => j.senderId === sender.senderId)
        .map((j) => j.scheduledAt)
        .sort((a, b) => a - b);

      for (let i = 1; i < times.length; i++) {
        expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(gapMs);
      }
    }
  });

  it('raises the gap to the sender\'s own value when it exceeds the campaign floor', () => {
    // Campaign asks for 1s; the sender insists on 10s. The sender must win.
    const plan = planSchedule({
      recipients: makeRecipients(5),
      senders: [{ id: 's1', label: 'Slow', hourlyLimit: 100, minGapMs: 10_000 }],
      startAt: T0,
      minGapMs: 1_000,
    });

    expect(plan.senders[0]!.effectiveGapMs).toBe(10_000);
    const times = plan.jobs.map((j) => j.scheduledAt);
    expect(times[1]! - times[0]!).toBe(10_000);
  });

  it('caps hourly capacity by the gap when the gap is the tighter constraint', () => {
    // A 5-minute gap physically allows only 12 sends/hour, whatever the limit says.
    const plan = planSchedule({
      recipients: makeRecipients(30),
      senders: [{ id: 's1', label: 'Throttled', hourlyLimit: 1_000, minGapMs: 300_000 }],
      startAt: T0,
      minGapMs: 0,
    });

    expect(plan.senders[0]!.effectiveHourlyCapacity).toBe(12);
    expect(plan.warnings.some((w) => w.code === 'GAP_CAPS_HOURLY_LIMIT')).toBe(true);
  });
});

describe('planSchedule — window alignment', () => {
  it('aligns windows to wall-clock hours, not to the start time', () => {
    // This is the invariant that keeps the planner in sync with the Redis counters,
    // which are keyed by floor(epochMs / HOUR_MS).
    const startAt = Date.UTC(2026, 0, 1, 10, 45, 0, 0);
    const plan = planSchedule({
      recipients: makeRecipients(10),
      senders: makeSenders(1, 100, 1_000),
      startAt,
      minGapMs: 1_000,
    });

    for (const window of plan.windows) {
      expect(window.windowStart % HOUR_MS).toBe(0);
    }
    expect(plan.windows[0]!.windowStart).toBe(hourWindowStart(startAt));
  });

  it('gives the first window only the capacity its remaining wall time allows', () => {
    // Start 10:59:00 with a 30s gap: only 2 sends fit before 11:00 (at :00 and :30).
    const startAt = Date.UTC(2026, 0, 1, 10, 59, 0, 0);
    const plan = planSchedule({
      recipients: makeRecipients(10),
      senders: [{ id: 's1', label: 'S', hourlyLimit: 100, minGapMs: 30_000 }],
      startAt,
      minGapMs: 0,
    });

    expect(plan.windows[0]!.count).toBe(2);
    expect(plan.warnings.some((w) => w.code === 'PARTIAL_FIRST_WINDOW')).toBe(true);
  });
});

describe('planSchedule — load balancing', () => {
  it('deals recipients evenly across senders', () => {
    const plan = planSchedule({
      recipients: makeRecipients(99),
      senders: makeSenders(3, 1_000, 0),
      startAt: T0,
      minGapMs: 0,
    });

    for (const sender of plan.senders) expect(sender.assigned).toBe(33);
  });

  it('distributes the remainder when the count does not divide evenly', () => {
    const plan = planSchedule({
      recipients: makeRecipients(100),
      senders: makeSenders(3, 1_000, 0),
      startAt: T0,
      minGapMs: 0,
    });

    expect(plan.senders.map((s) => s.assigned).sort((a, b) => b - a)).toEqual([34, 33, 33]);
  });

  it('starts every sender in the first window rather than draining them in turn', () => {
    const plan = planSchedule({
      recipients: makeRecipients(60),
      senders: makeSenders(3, 10, 0),
      startAt: T0,
      minGapMs: 0,
    });

    expect(plan.windows[0]!.bySender).toHaveLength(3);
  });
});

describe('planSchedule — edge cases', () => {
  it('returns an empty plan when there are no recipients', () => {
    const plan = planSchedule({
      recipients: [],
      senders: makeSenders(3),
      startAt: T0,
      minGapMs: 2_000,
    });

    expect(plan.jobs).toHaveLength(0);
    expect(plan.windowCount).toBe(0);
    expect(plan.finishesAt).toBe(T0);
    expect(describePlan(plan)).toBe('Nothing to schedule yet.');
  });

  it('does not throw when there are no senders', () => {
    // The compose form calls this on every keystroke, possibly before senders load.
    // Throwing would blank the UI mid-typing.
    const plan = planSchedule({
      recipients: makeRecipients(10),
      senders: [],
      startAt: T0,
      minGapMs: 2_000,
    });

    expect(plan.jobs).toHaveLength(0);
    expect(plan.totalCapacityPerHour).toBe(0);
  });

  it('warns that a single sender has no failover', () => {
    const plan = planSchedule({
      recipients: makeRecipients(10),
      senders: makeSenders(1),
      startAt: T0,
      minGapMs: 2_000,
    });

    expect(plan.warnings.some((w) => w.code === 'SINGLE_SENDER_NO_FAILOVER')).toBe(true);
  });

  it('strands nothing when one sender has zero capacity', () => {
    const plan = planSchedule({
      recipients: makeRecipients(20),
      senders: [
        { id: 'good', label: 'Good', hourlyLimit: 100, minGapMs: 0 },
        { id: 'dead', label: 'Dead', hourlyLimit: 0, minGapMs: 0 },
      ],
      startAt: T0,
      minGapMs: 0,
    });

    expect(plan.jobs).toHaveLength(20);
    expect(plan.jobs.every((j) => j.senderId === 'good')).toBe(true);
  });

  it('warns on campaigns spanning more than a day', () => {
    const plan = planSchedule({
      recipients: makeRecipients(1_000),
      senders: makeSenders(1, 10, 0),
      startAt: T0,
      minGapMs: 0,
    });

    expect(plan.windowCount).toBe(100);
    expect(plan.warnings.some((w) => w.code === 'LONG_RUNNING_CAMPAIGN')).toBe(true);
  });

  it('handles 10,000 recipients quickly enough for a keystroke-rate forecast', () => {
    const started = performance.now();
    const plan = planSchedule({
      recipients: makeRecipients(10_000),
      senders: makeSenders(5, 200, 2_000),
      startAt: T0,
      minGapMs: 2_000,
    });
    const elapsed = performance.now() - started;

    expect(plan.jobs).toHaveLength(10_000);
    expect(elapsed).toBeLessThan(500);
  });
});

describe('planSchedule — ordering guarantees', () => {
  it('assigns a unique sequence number to every recipient, covering 0..n-1', () => {
    const plan = planSchedule({
      recipients: makeRecipients(50),
      senders: makeSenders(3, 100, 1_000),
      startAt: T0,
      minGapMs: 1_000,
    });

    const sequences = plan.jobs.map((j) => j.sequenceNo).sort((a, b) => a - b);
    expect(sequences).toEqual(Array.from({ length: 50 }, (_, i) => i));
  });

  it('returns jobs in execution order', () => {
    const plan = planSchedule({
      recipients: makeRecipients(50),
      senders: makeSenders(3, 100, 1_000),
      startAt: T0,
      minGapMs: 1_000,
    });

    for (let i = 1; i < plan.jobs.length; i++) {
      expect(plan.jobs[i]!.scheduledAt).toBeGreaterThanOrEqual(plan.jobs[i - 1]!.scheduledAt);
    }
  });

  it('keeps each sender\'s slice in submission order', () => {
    const plan = planSchedule({
      recipients: makeRecipients(60),
      senders: makeSenders(3, 10, 1_000),
      startAt: T0,
      minGapMs: 1_000,
    });

    for (const sender of plan.senders) {
      const sequences = plan.jobs
        .filter((j) => j.senderId === sender.senderId)
        .sort((a, b) => a.scheduledAt - b.scheduledAt)
        .map((j) => j.sequenceNo);

      const sorted = [...sequences].sort((a, b) => a - b);
      expect(sequences).toEqual(sorted);
    }
  });
});
