# Scalability

What actually happens at 1,000 / 100,000 / 1,000,000 recipients, and where the real
bottleneck is at each step.

The honest short version: **the architecture is sound to roughly 100k; the first thing
that breaks is Redis memory from fully-materialised delayed jobs, and the fix is already
designed but not finished.**

---

## The horizontal-scaling property

Everything below rests on one thing: **correctness does not depend on how many processes
are running.**

```
    ┌──────────┐  ┌──────────┐  ┌──────────┐
    │ worker 1 │  │ worker 2 │  │ worker N │     ← scale freely
    └────┬─────┘  └────┬─────┘  └────┬─────┘
         └─────────────┼─────────────┘
                       ▼
              ┌─────────────────┐
              │ Redis Lua script│   ← atomic: the ONLY place
              │ (check+consume) │      the limit is decided
              └─────────────────┘
```

Because every check-and-increment is a single Lua script, Redis serialises them. No
interleaving is possible, so three workers enforce a 200/hour limit exactly as correctly
as one. The same holds for circuit-breaker transitions.

Verify it yourself:

```bash
docker compose --profile app up --scale worker=3
```

If limits were enforced in Node, this command would triple the effective send rate.

---

## At 1,000 recipients — the brief's stated case

Comfortable in every dimension.

| Resource | Cost |
|---|---|
| Postgres | 1,000 rows, one chunked `createMany` |
| Redis | 1,000 delayed jobs ≈ **400–500 KB** |
| Planning | ~5 ms (measured; the test suite asserts 10,000 plans in under 500 ms) |
| Delivery | 3 senders × 50/hr → 7 windows, ~6h40m |

**They are never all due at once.** `planSchedule()` spreads them at creation time. This
is the whole point of planning ahead rather than reacting: the reactive design would have
1,000 jobs wake simultaneously and 950 immediately bounce off the rate limiter.

---

## At 100,000 recipients

Still works, with one thing to watch.

| Resource | Cost | Assessment |
|---|---|---|
| Postgres insert | 100 chunks × 1,000 | ~2–4 s in one transaction — fine |
| Redis | 100,000 delayed jobs ≈ **40–50 MB** | ⚠️ Noticeable but survivable |
| Planning | ~200 ms | Fine server-side; too slow for per-keystroke UI |
| Delivery | 3 senders × 200/hr → ~166 hours | The real constraint is sender capacity, not the system |

**Current hard cap is `MAX_LEADS_PER_CAMPAIGN = 50,000`**, so 100k means two campaigns
today.

### The first real bottleneck: fully-materialised delayed jobs

Every job is enqueued at creation. At 100k that is ~50 MB of Redis holding jobs that will
not run for days. Redis is memory-resident, so this is the first resource that becomes
uncomfortable — and `maxmemory-policy noeviction` means Redis will start refusing writes
rather than silently dropping schedule data (the right failure, but still a failure).

**The designed fix — the campaign pump.** Materialise only the next *N* hours; a
self-chaining delayed job wakes before that horizon expires and enqueues the next batch.
Redis then holds a bounded working set regardless of campaign size, while Postgres — which
is disk-backed and entirely happy with millions of rows — retains the full schedule.

> **Status: wired, not finished.** `PUMP_THRESHOLD_RECIPIENTS`, `PUMP_HORIZON_HOURS`, the
> `campaign-pump` queue and the `materializedThrough` column all exist, and the worker
> routes pump jobs — but **the handler is a stub**. Campaigns are currently materialised
> in full regardless of size. At the 50k cap this is ~25 MB and perfectly workable, which
> is why it was left. It is the first thing to finish for the next order of magnitude.
> Tracked in [devlog § Open items](./06-DEVLOG.md#open-items).

Note the pump is *not* cron: a delayed job that enqueues its own successor.

### Planning cost in the browser

`planSchedule()` runs on every compose-form change. At 10,000 recipients it is under
500 ms (asserted in the test suite), and `useDeferredValue` keeps typing responsive.

Beyond ~50,000 the browser would stutter. The mitigation is already available: the plan
depends only on the recipient **count**, never the values, so the forecast can be computed
from a number alone — `previewPlan()` on the server does exactly this. Switching the UI
to a debounced server preview above a threshold is a small change.

---

## At 1,000,000 recipients

Beyond what is built. What would need to change, roughly in order:

1. **Finish the pump** — non-negotiable at this size.
2. **Partition `email_jobs`** by `hourWindow` or `campaignId`. A single table with a
   billion rows makes index maintenance and vacuum painful; partitioning also makes
   dropping completed campaigns a `DROP PARTITION` instead of a long `DELETE`.
3. **`COPY` instead of `createMany`** for bulk insert — roughly an order of magnitude
   faster for millions of rows.
4. **Redis Cluster**, sharded by `tenantId`. Rate-limit keys are already tenant-prefixed,
   so they shard cleanly with no key-design change.
5. **Sender capacity becomes the only real constraint.** 1M emails at 200/hour/sender
   needs 5,000 sender-hours. This stops being an engineering problem and becomes a
   deliverability and provisioning one.
6. **Separate worker pools per tenant**, so one large tenant cannot starve others.

---

## Per-component analysis

### Postgres

**Currently fine.** Indexes are tuned for the hot paths:

```prisma
@@index([tenantId, status, scheduledAt])   // the worker's "what is due" query
@@index([status, lockedAt])                // the reaper's abandoned-claim scan
@@index([campaignId, sequenceNo])          // ordering
```

**Watch:** the campaign-list endpoint calls `getCampaignCounts()` per row. It is one
grouped query rather than seven counts — but it is still one query per campaign. At
hundreds of campaigns per page this becomes N+1. Fix: a single grouped query across all
campaign ids on the page, or a materialised counter column.

**Connection pool** is the classic limit. Each API and worker instance opens its own pool;
at 20 instances × 10 connections you reach Postgres's default `max_connections` of 100.
PgBouncer in transaction mode is the standard answer.

### Redis

Covered above. Two additional notes:

- **AOF `everysec`** bounds worst-case loss to ~1 second, and the startup reconciler closes
  even that gap by re-enqueuing from Postgres.
- **Three separate connections** (general / BullMQ / subscriber) because BullMQ workers
  issue *blocking* reads that occupy a connection for seconds. Sharing one would put
  rate-limit checks behind a blocked worker read — a latency bug that only appears under
  load and looks like "Redis is slow".

### Elasticsearch

**Least critical component**, by design. It is a derived store: the app boots without it,
search degrades to a Postgres `ILIKE` query, and `npm run es:reindex` rebuilds the whole
index from Postgres.

Indexing is asynchronous on its own queue, so a wedged cluster never blocks sending.
`refresh: false` on writes avoids forcing a segment flush per document, which would
collapse indexing throughput.

At scale: time-based indices (`throttle-emails-2026-09`) with ILM, so old data rolls to
cheaper storage and is dropped by policy rather than by `DELETE` query.

### The worker

`WORKER_CONCURRENCY` is safe to raise — correctness under parallelism comes from the
atomic DB claim and the Lua limiter, not from keeping concurrency low.

The practical ceiling is SMTP connections. `SMTP_POOL_MAX_CONNECTIONS` (default 5) caps
connections per sender, so concurrency far above `senders × pool size` just produces
workers waiting on a connection.

**The genuine constraint is the rate limit itself.** At 200/hour/sender with a 2-second
gap, a single sender needs *one* send every 18 seconds. Concurrency exists to service
*many senders* in parallel, not to push one sender harder.

---

## Failure modes and behaviour

| Failure | Behaviour | Recovery |
|---|---|---|
| Worker killed mid-send | Row stuck `SENDING` | Reaper returns it after `JOB_LOCK_TTL_MS` |
| Redis flushed | Postgres has rows, Redis has no jobs | Reconciler re-enqueues from Postgres |
| Process down for an hour | Jobs overdue on restart | Re-enqueued **re-spaced**, not dumped as a burst |
| Postgres down | API refuses to boot; worker jobs fail and retry | Recovers when Postgres returns |
| Elasticsearch down | Search degrades to Postgres; indexing skipped | `npm run es:reindex` |
| Slack down / disconnected | Notification is a no-op | Resumes with no redeploy |
| SMTP failing for one sender | Circuit opens, traffic reroutes, Slack alert | Half-open probe after cooldown |
| All senders exhausted | Jobs deferred to the next window | Never dropped, never failed |
| Rate limit hit | `moveToDelayed()`, no attempt consumed, order preserved | Resumes next window |

---

## What I would do first with more time

1. **Finish the campaign pump.** The single change that unlocks the next order of magnitude.
2. **Fix the N+1 in the campaign list.** Small, and it is the first thing to bite in normal use.
3. **Integration tests against real Postgres/Redis** for the full schedule → restart → send
   cycle. Currently verified by unit tests and manual runs; this is the highest-value
   missing test.
4. **Per-tenant queue isolation**, so one large tenant cannot starve another.
5. **PgBouncer** before horizontal scaling past a handful of instances.
