# Architecture

Deep dive on the pieces that matter. For setup see the [README](../README.md); for status
and the repo map see [00-PROJECT-OVERVIEW](./00-PROJECT-OVERVIEW.md).

---

## Data store roles

Getting this ordering right is what makes restart recovery tractable.

| Store | Role | Rebuildable from |
|---|---|---|
| **Postgres** | **Source of truth.** The schedule lives here. | — |
| **Redis** | Working set: delayed jobs, rate-limit counters, circuit state, OAuth state | Postgres |
| **Elasticsearch** | Derived search index | Postgres |

Both Redis and Elasticsearch are rebuildable from Postgres; **neither is rebuildable from
the other**. So on boot we reconcile Redis *against* Postgres, never the reverse — and
Elasticsearch can be dropped entirely without data loss.

This is also why Elasticsearch is not a hard startup dependency: a search cluster being
down must not stop email from sending.

---

## The scheduling pipeline

```
┌─────────────────────────────────────────────────────────────────────┐
│ POST /api/campaigns                                                 │
└──────────────────────────────┬──────────────────────────────────────┘
                               ▼
   1. resolveSenders()         authoritative — client's list not trusted.
                               campaign.hourlyLimit is a CEILING on each
                               sender's own, never a raise.
                               ▼
   2. parseLeads()             re-parse and re-dedupe SERVER-SIDE. The
                               client already did this to show a count;
                               that was UX, this is the boundary.
                               ▼
   3. planSchedule()           PURE. No clock, no I/O, no randomness.
                               ▼
   4. Postgres transaction     campaign + all EmailJob rows, chunks of 1,000,
                               120s timeout (a 50k campaign exceeds the 5s default)
                               ▼
   5. BullMQ addBulk           jobId = EmailJob.id, delay = scheduledAt - now
                               ── AFTER the transaction commits ──
```

**Why 5 must follow 4.** Enqueue first and a worker can pick up a job whose row does not
exist yet: it finds nothing, logs a warning, and the email silently never sends. Commit
first and the worst case is a row in Postgres with no Redis job — which the reconciler
repairs automatically. One failure mode is silent and permanent; the other is loud and
self-healing.

---

## `planSchedule()` — the shared planner

The single most important function in the repo. Imported by **both** the API and the
React compose form.

### Purity contract

- No `Date.now()` — the caller passes `startAt`
- No `Math.random()`
- No I/O, no logging
- Never throws on soft problems (empty senders → empty plan + warnings)

Violating any of these desynchronises the forecast from reality. The last one matters
because it runs on every keystroke in the compose form — a throw would blank the UI
mid-typing.

### Algorithm

**Round-robin, then time-cursor.**

Recipients are dealt round-robin across senders (not contiguous chunks) so every sender is
busy from the first window. Chunking would have sender A send its whole allocation before
B starts — wasting parallel capacity and producing a forecast that looks nothing like the
balanced reality the worker produces.

Each sender then walks a cursor forward:

```
for each recipient assigned to this sender:
    loop:
        window = hourWindowStart(cursor)
        if usage[window] >= capacity:
            cursor = hourWindowEnd(cursor)     # quota spent — jump to next window
            continue
        break
    place send at cursor
    usage[window] += 1
    cursor += effectiveGap
```

The cursor approach handles three things a naive `index / capacity` formula gets wrong:

1. **A partial first window** — a 10:45 start has only 15 minutes of the 10:00 hour
2. **The gap running out of wall time** before the quota is exhausted
3. **Quota exhaustion mid-window**, requiring a jump to the boundary

### Two ceilings, tighter wins

```
effectiveHourlyCapacity = min(hourlyLimit, floor(3_600_000 / effectiveGapMs))
```

A 2-second gap physically caps a sender at 1,800/hour whatever the configured limit says.
Surfacing that as a `GAP_CAPS_HOURLY_LIMIT` warning tells a user asking for 3,000/hr with
a 2s gap that their limit is unreachable — **before** they schedule anything.

The gap itself is `max(campaignMinGap, senderMinGap)`: the campaign floor can only widen
spacing, never tighten it. A sender declaring it needs 5s between sends must never be
driven at 2s.

---

## ⚠️ The window-alignment invariant

**The subtlest correctness property in the system.**

Hour windows align to **wall-clock UTC hours**, not to the campaign start time — because
the Redis rate-limit key is inherently wall-clock based:

```
throttle:rl:{tenantId}:{senderId}:{floor(epochMs / 3_600_000)}
```

If the planner bucketed from `startAt` while the limiter bucketed from the wall clock,
a campaign starting at 10:45 would have the planner's "window 0" spanning 10:45–11:45
while the limiter used two separate buckets with two separate quotas.

Everything would still *work* — emails send, limits hold, nothing errors. Only the
forecast would be quietly wrong, and only for campaigns not starting on the hour.

**The enforcement mechanism is a shared import.** Both sides use `hourWindowStart()` /
`hourWindowKey()` from [`packages/core/src/time.ts`](../packages/core/src/time.ts). There
is no second implementation to drift. See [devlog §2](./06-DEVLOG.md).

---

## The worker pipeline

Order is deliberate, not incidental.

```
 1. Load job + campaign + sender pool        skip if cancelled/paused/terminal
 2. Choose a sender                          health-scored; reroutes off open circuits
 3. Acquire a rate-limit slot   ← Redis, atomic
 4. CLAIM the job               ← Postgres, atomic compare-and-swap
 5. Send over SMTP
 6. Record outcome + circuit state
```

**3 before 4.** The limiter is cheaper and far more likely to deny. Claiming first would
flip a row to `SENDING` and immediately revert it on every throttled job — thousands of
pointless writes under load.

**4 before 5.** The claim is what makes double-sending impossible. It must commit before
a single byte reaches SMTP.

### The claim

```sql
UPDATE email_jobs
   SET status='SENDING', attempts=attempts+1, "lockedAt"=NOW(), "lockedBy"=$worker
 WHERE id=$1 AND status IN ('SCHEDULED','QUEUED','RESCHEDULED')
RETURNING id
```

Zero rows means another worker owns it → return cleanly, and hand the rate-limit slot back
(we consumed budget we will not use). `lockedAt` doubles as the reaper's input.

### Rate-limit denial is not failure

```ts
await job.moveToDelayed(newScheduledAt, token);
throw new DelayedError();
```

`moveToDelayed()` **does not consume a BullMQ attempt**. Throwing a normal error instead
would burn the retry budget on being throttled and eventually mark a perfectly good email
`FAILED` — exactly what the brief forbids.

`DelayedError` is also filtered out of the `failed` event handler, so a correctly
throttling system does not fill the log with what look like failures.

### Deterministic stagger

After a restart, hundreds of overdue jobs wake together. Rescheduling each by exactly the
same `retryAfterMs` makes them wake together *again* — a thundering herd that repeats
indefinitely.

```ts
function staggerFor(sequenceNo: number, gapMs: number): number {
  return (sequenceNo % WORKER_CONCURRENCY) * Math.max(gapMs, 250);
}
```

Derived from `sequenceNo` rather than `Math.random()`, so behaviour stays reproducible.

---

## Rate limiting

Three checks, one Lua script, one round-trip:

1. Tenant-wide hourly ceiling (0 = disabled)
2. Per-sender hourly ceiling
3. Minimum gap since that sender's last send

Ordered by **blast radius**, not cost — so a global stop is reported as a global stop
rather than masked by a per-sender gap message. The reason code drives both the user-facing
status and whether Slack fires.

**Counters increment only on the success path.** A denied job must not consume the budget
it was denied for, or a blocked backlog would burn the next window's quota just by being
checked.

**TTL is 2 hours, not 1** — outliving the window, so a late job from a paused worker sees
the correct count rather than a fresh zero.

### Why Lua

N workers × M concurrent jobs all reading "sent 199 of 200" and all concluding they have
room is a read-modify-write race. It is in the protocol, not the language — no amount of
careful JavaScript fixes it, and in-memory counters make it worse (two instances each
allow 200/hour; the real rate is 400/hour).

Redis executes Lua atomically. Nothing interleaves between the read and the write.

---

## Circuit breaker

```
CLOSED ──(N consecutive failures)──▶ OPEN
OPEN ──(cooldown elapsed)──▶ HALF_OPEN ──(M successes)──▶ CLOSED
                                  └──(any failure)──▶ OPEN (cooldown restarts)
```

**`HALF_OPEN` admits one probe at a time.** Without that lock, the moment a cooldown
expires every waiting worker probes simultaneously — precisely the hammering the breaker
exists to prevent. The probe slot has its own TTL so a worker dying mid-probe cannot wedge
the breaker shut forever.

### Health score

```
healthScore = remainingHourlyBudget × (1 − recentFailureRate)     // 0 if circuit open
```

Multiplying is the point. Budget alone picks a fresh-but-broken sender over a
busy-but-healthy one; reliability alone piles everything onto one sender until it hits its
limit.

`recentFailureRate` comes from a rolling outcome ring stored as a string of `0`/`1`
characters in the Redis hash, capped at `CIRCUIT_ROLLING_WINDOW`.

### Scoring is side-effect free; selection is not

`selectHealthiestSender()` **reads** state to score candidates, then confirms the winner
with `checkSenderEligibility()` — which *mutates* (it promotes `OPEN → HALF_OPEN` and
claims the probe slot). Scoring all candidates with the mutating call would claim a probe
slot on every sender being considered.

### Reroute at pickup, not by rewriting queued jobs

The planner assigns a sender hours in advance. By the time a job runs, that sender may be
out of budget or circuit-open.

Rewriting thousands of queued delayed jobs in Redis is slow and racy — a job can be picked
up mid-rewrite. Re-deciding at pickup is a single atomic read, always based on current
truth. The job records `plannedSenderId` vs `actualSenderId`, so reroutes are visible in
the UI and auditable.

---

## Restart survival

Three distinct failure modes:

| Mode | Cause | Symptom | Fix |
|---|---|---|---|
| **A** | Killed mid-send | Row stuck `SENDING`, `lockedAt` never clears | Reaper |
| **B** | Redis lost data | Postgres has `SCHEDULED` rows, Redis has none — silent non-delivery | Reconciler |
| **C** | Process simply down | Jobs became due while offline | BullMQ native; reconciler re-spaces the backlog |

`runStartupRecovery()` runs **before the worker consumes anything**. Waiting for the first
scheduled pass would strand jobs for up to a full interval, which on a demo restart looks
exactly like the system losing them.

**Order matters: reap before reconcile**, so rows freed by the reaper are re-enqueued in
the same pass.

### The reconciler's trick

Rather than checking each job's existence in Redis (one round-trip per job — unusable at
50k), it **blindly re-adds** them. BullMQ ignores an `add()` whose `jobId` already exists,
so re-adding is a cheap no-op for the common case and a repair for the rare one. The safe
operation and the fast operation are the same operation.

### `attempts` is not decremented by the reaper

A crash mid-send might have happened *after* SMTP accepted the message. Treating it as a
free retry risks a duplicate. Counting it is conservative — worst case an email gets one
fewer retry than configured.

---

## No cron — the self-chaining delayed job

Forbidden: `node-cron`, `agenda`, `bree`, OS `crontab`, **and BullMQ's `repeat:` option**
(cron-expression backed).

Instead, each maintenance run ends by enqueuing its own successor:

```ts
await runMaintenancePass();
await scheduleMaintenance(kind, iteration + 1, env.RECONCILE_INTERVAL_MS);
```

An ordinary delayed job that happens to schedule its next run.

- **Survives restarts** — the successor is persisted in Redis before the current run
  completes, and `startMaintenanceChain()` re-seeds at boot if it is ever lost.
- **Cannot double** — a deterministic `jobId` per iteration means several worker instances
  starting at once produce one chain, not one each.
- **Cannot break** — `runMaintenancePass()` never rethrows, so a failed pass does not
  terminate the chain. Maintenance stopping permanently would be invisible until something
  else went wrong.

---

## Queue separation

Four queues so a slow third party cannot consume the slots email sending needs:

| Queue | Concurrency | Why separate |
|---|---|---|
| `email-send` | `WORKER_CONCURRENCY` | The real work |
| `campaign-pump` | **1** | Two concurrent passes would duplicate the chain |
| `search-index` | 10 | A wedged ES cluster must not block sending |
| `notifications` | 3 | A 5-second Slack timeout must not delay a send |

With one queue, any unreachable third party produces head-of-line blocking that looks like
a scheduler bug.

---

## Idempotency — three layers

| Layer | Mechanism | Catches |
|---|---|---|
| 1 | BullMQ `jobId` = EmailJob id | Same job enqueued twice (retried API call, reconciler, pump) |
| 2 | **Atomic DB claim** | Two workers racing for the same job |
| 3 | `@@unique([campaignId, recipientEmail])` | Anything reaching the database |

Plus `Idempotency-Key` on `POST /api/campaigns`, and a deterministic SMTP `Message-ID`
derived from the EmailJob id — so if a message ever did reach a provider twice, both
copies carry the same id and the duplicate is *provable* rather than merely suspected.

---

## Slack notification debouncing

When a sender hits its limit with 1,000 jobs behind it, every one independently discovers
the limit. Naively: 1,000 Slack messages in seconds — app rate-limited by Slack, channel
muted by the customer, the one message that mattered buried.

```ts
const result = await redis.set(key, '1', 'EX', ttl, 'NX');
return result === 'OK';   // exactly one caller wins
```

`SETNX` is atomic — checking `EXISTS` then `SET` would let several workers pass
simultaneously, reintroducing in the alerting path the exact race the rate limiter exists
to avoid.

The key embeds the hour window, so the alert re-arms next hour with no cleanup.

**Fails open.** A Redis error allows the notification: a missed alert is worse than a
duplicate, and the alerting path must never break sending.
