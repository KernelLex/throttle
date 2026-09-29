# Throttle — Build Plan

> Phased delivery plan. Each phase ends at a **demoable checkpoint** — something you can
> show on screen. Phases are ordered so that the riskiest, most differentiating work
> (the scheduler core) lands before the cosmetic work.
>
> Status legend: `TODO` · `WIP` · `DONE` · `BLOCKED`
> Live status is tracked in [`00-PROJECT-OVERVIEW.md`](./00-PROJECT-OVERVIEW.md).

---

## Guiding constraints (never violate)

These come straight from the brief and are non-negotiable. Every phase is checked against them.

| # | Constraint | How we honour it |
|---|-----------|------------------|
| C1 | **No cron. Anywhere.** | No `node-cron`, `agenda`, `bree`, `crontab`. Also **no BullMQ `repeat:`** — that option is cron-expression backed. Recurring work uses *self-chaining delayed jobs*. |
| C2 | **Survives restart** | All scheduling state lives in Postgres + Redis (AOF on). Process memory holds nothing authoritative. A killed worker loses at most one in-flight send, which is recovered by the stalled-job reaper. |
| C3 | **No duplicate sends** | Three independent layers: BullMQ `jobId`, a DB compare-and-swap claim, and a unique `(campaignId, recipientEmail)` constraint. See [Architecture §6](./03-ARCHITECTURE.md). |
| C4 | **No public endpoints** | Every route except `/healthz` and the two OAuth callbacks sits behind session auth + tenant scoping. Bull Board included. See [Security](./04-SECURITY.md). |
| C5 | **Limits configurable** | No magic numbers in code. All limits come from env → `config.ts` (Zod-validated) → DB per-sender overrides. |

---

## Phase 0 — Foundation & Tooling

**Goal:** `docker compose up` gives a working, empty system. Nothing to demo yet except green health checks.

- [ ] npm workspaces monorepo: `apps/api`, `apps/web`, `packages/core`
- [ ] TypeScript strict everywhere (`strict: true`, `noUncheckedIndexedAccess: true`)
- [ ] ESLint + Prettier, shared config
- [ ] `docker-compose.yml`: Postgres 16, Redis 7 (AOF enabled), Elasticsearch 8
- [ ] `.env.example` with every variable documented inline
- [ ] `config.ts` — Zod-validated env loader that **crashes on boot** if a required var is missing
- [ ] Structured logging (Pino) with request IDs
- [ ] `/healthz` (liveness) and `/readyz` (checks PG + Redis + ES reachability)

**Checkpoint:** `curl localhost:4000/readyz` → `{"postgres":"ok","redis":"ok","elasticsearch":"ok"}`

**Why Redis AOF matters:** the default Redis config uses RDB snapshots, which can lose the
last few seconds of writes on a hard kill. Since delayed jobs *are* our schedule, that's
data loss on exactly the restart scenario the demo video has to show. `appendonly yes`.

---

## Phase 1 — `packages/core`: the shared planner

**Goal:** the single most important file in the repo exists and is thoroughly tested.

This is the piece that makes the Delivery Planner honest. `planSchedule()` is a **pure
function** — no I/O, no clock reads, no randomness. It is imported by *both* the Express
API (to schedule for real) and the React compose form (to forecast). Same input, same
output, both sides.

- [ ] Shared TS types: `Sender`, `PlanInput`, `PlannedJob`, `PlanResult`, `WindowSummary`
- [ ] Zod schemas shared between API validation and frontend form validation
- [ ] `planSchedule(input: PlanInput): PlanResult` — deterministic assignment
- [ ] `parseLeads(text: string)` — CSV/TXT → deduped, validated email list
- [ ] Vitest suite: ordering, window rollover, uneven sender counts, 1 sender, 0 senders, 10k leads, DST boundary

### `planSchedule()` contract

```ts
interface PlanInput {
  recipients:  string[];      // already deduped + validated
  senders:     PlanSender[];  // { id, hourlyLimit, minGapMs }
  startAt:     number;        // epoch ms — passed in, never read from clock
  minGapMs:    number;        // campaign floor; per-sender gap may be larger
}

interface PlanResult {
  jobs:          PlannedJob[];    // one per recipient, with senderId + scheduledAt
  windows:       WindowSummary[]; // [{ windowStart, count, bySender }] → the bar chart
  finishesAt:    number;
  windowCount:   number;
  totalCapacityPerHour: number;
}
```

**Algorithm:** round-robin recipients across senders to balance load, then within each
sender walk forward filling hour windows up to that sender's `hourlyLimit`, spacing sends
by `max(campaign.minGapMs, sender.minGapMs)`. Overflow rolls into the next window.
Global `sequenceNo` preserves submission order for tie-breaking and audit.

**Checkpoint:** `npm test -w packages/core` green. Feed it 1,000 leads / 3 senders / 50-per-hour
and assert it reports exactly 7 windows — the brief's own example.

---

## Phase 2 — Persistence layer

**Goal:** the data model that makes C2 and C3 possible.

- [ ] Prisma schema: `Tenant`, `User`, `RefreshToken`, `Sender`, `Campaign`, `EmailJob`, `SlackInstallation`, `AuditLog`
- [ ] Indexes tuned for the hot queries (`[tenantId, status, scheduledAt]`, `[campaignId, sequenceNo]`)
- [ ] Unique constraint `(campaignId, recipientEmail)` — the last line of duplicate defence
- [ ] Migrations + a seed script (demo tenant, 3 Ethereal senders)
- [ ] AES-256-GCM helper for SMTP passwords and Slack tokens at rest

**Checkpoint:** `npx prisma studio` shows the seeded tenant with 3 senders.

**Note on Prisma:** used for everything *except* the atomic job claim, which is raw SQL.
Prisma has no primitive for `UPDATE ... WHERE status = 'X' RETURNING *`, and that statement
is the thing standing between us and double-sends. See Phase 4.

---

## Phase 3 — Auth & security spine

**Goal:** C4 satisfied *before* there are endpoints worth protecting. Retrofitting auth is
how endpoints get left public.

- [ ] Google OAuth 2.0 authorization-code flow **with PKCE**, implemented on the backend
- [ ] Signed, single-use `state` parameter (CSRF defence on the OAuth handshake)
- [ ] Session = short-lived access JWT (15 min) + rotating refresh token (7 day), both `httpOnly` `Secure` `SameSite=Lax` cookies
- [ ] **Refresh token reuse detection**: tokens are stored hashed with a `familyId`; presenting an already-rotated token revokes the whole family and forces re-login
- [ ] `requireAuth` middleware → attaches `{ userId, tenantId, role }`
- [ ] `requireRole('ADMIN')` for privileged surfaces
- [ ] **Tenant scoping enforced at the repository layer**, not in route handlers — a handler that forgets `tenantId` shouldn't compile
- [ ] Helmet, strict CORS allowlist, per-route rate limiting, body size caps
- [ ] CSRF double-submit token for all state-changing requests
- [ ] Zod validation on every request body, query and param
- [ ] Audit log writes on auth events and campaign mutations

**Checkpoint:** every route returns `401` without a cookie. Prove it with an automated test
that enumerates the Express router and asserts each route has `requireAuth` in its stack —
so a future route added without auth *fails CI*.

---

## Phase 4 — Scheduler core ⭐ the heart of the assignment

**Goal:** schedule → wait → send, with limits enforced and nothing sent twice.

### 4a. Queues
- [ ] `email-send` — the main delayed queue
- [ ] `campaign-pump` — self-chaining materializer (C1-safe recurring work)
- [ ] `search-index` — Elasticsearch indexing, off the SMTP hot path
- [ ] `notifications` — Slack delivery, so a slow Slack API never blocks a send

### 4b. Scheduling
- [ ] `POST /api/campaigns` → validate → `planSchedule()` → bulk-insert `EmailJob` rows → enqueue delayed jobs
- [ ] `jobId = emailJob.id` — BullMQ silently rejects duplicate job IDs (idempotency layer 1)
- [ ] `Idempotency-Key` header support so a retried POST can't create a second campaign
- [ ] Bulk insert + `addBulk` in chunks of 1,000, inside a transaction

### 4c. The worker
- [ ] Configurable concurrency (`WORKER_CONCURRENCY`, default 5)
- [ ] **Atomic claim** before any SMTP work:
      `UPDATE email_jobs SET status='SENDING', attempts=attempts+1, locked_at=now(), locked_by=$worker
       WHERE id=$1 AND status IN ('SCHEDULED','QUEUED') RETURNING *`
      → zero rows means another worker already owns it → return cleanly. (idempotency layer 2)
- [ ] `acquireSendSlot` Lua script — one atomic Redis round-trip checking circuit state,
      hourly budget and min-gap together
- [ ] Denied → `job.moveToDelayed(nextWindowStart)`, status `RESCHEDULED`, `rescheduleCount++`
- [ ] Nodemailer send via the chosen sender's SMTP, capture Ethereal preview URL
- [ ] Exponential backoff retries on transient SMTP failures; permanent failures fail fast
- [ ] Stalled-job reaper for workers killed mid-send

### 4d. Restart survival
- [ ] Startup reconciler: find `EmailJob`s that are `SCHEDULED` in the DB but have no
      corresponding Redis job, and re-enqueue them (heals a Redis flush)
- [ ] Startup reaper: `SENDING` rows with a `locked_at` older than the lock TTL are
      returned to `SCHEDULED` (heals a hard kill)
- [ ] Past-due jobs fire immediately rather than being skipped

**Checkpoint — this is the money demo:** schedule 20 emails over 10 minutes, `docker compose
stop api worker`, wait past a due time, `docker compose start`, watch the overdue ones send
once (not twice) and the future ones still fire on time.

---

## Phase 5 — Rate limiting, concurrency & Slack

**Goal:** behave like a real provider under load.

- [ ] Redis token bucket keyed `rl:{tenantId}:{senderId}:{hourEpoch}`, TTL 2h
- [ ] All check-and-increment logic in **Lua** — atomic, so it's correct across N worker processes
- [ ] Min-gap enforced per sender via `gap:{senderId}` CAS, not `setTimeout`
- [ ] Limits resolved per sender from DB, falling back to env defaults
- [ ] On limit hit: reschedule into the next window preserving `sequenceNo` order — **never drop, never fail**
- [ ] Slack OAuth v2 install flow (`/api/slack/install` → Slack → `/api/slack/callback`)
- [ ] Encrypted webhook URL + bot token stored per tenant
- [ ] **Live Slack message** on limit hit, with sender, window, backlog size and resume time
- [ ] **Debounce**: `SETNX slack:notified:{tenant}:{sender}:{window}` with TTL — exactly one
      alert per sender per hour window, not one per blocked job
- [ ] Disconnect/reconnect handled: no installation → silently skip, no crash; reconnect
      starts notifications again with no redeploy

**Checkpoint:** set `MAX_EMAILS_PER_HOUR_PER_SENDER=5`, fire 50 emails, watch 5 send, 45
reschedule, **one** Slack message arrive, and the rest resume next window.

---

## Phase 6 — Health-aware rotation + circuit breaker ⭐ differentiator #2

**Goal:** upgrade round-robin into something production-shaped.

- [ ] Redis hash per sender: `{ sent, failed, consecutiveFailures, state, openedAt, probes }`
- [ ] Health score = `remainingHourlyBudget × (1 − recentFailureRate)`; open circuit ⇒ 0
- [ ] Breaker states: `CLOSED → OPEN` after N consecutive failures → `HALF_OPEN` after cooldown → probe → `CLOSED` or back to `OPEN`
- [ ] **Reroute at pickup, not by rewriting queued jobs.** If the planned sender's circuit is
      open when the worker picks the job up, re-score and send from the healthiest sender.
      Record `plannedSenderId` vs `actualSenderId` so the UI can show the reroute.
- [ ] Slack alert on breaker open **and** on recovery
- [ ] `GET /api/senders/health` → live scores, states, budgets for the dashboard

**Why reroute at pickup:** mutating thousands of already-queued delayed jobs in Redis is
slow and racy — a job can be picked up mid-rewrite. Deciding at pickup is a single atomic
read and is always based on current truth.

---

## Phase 7 — Elasticsearch

- [ ] `emails` index with an explicit mapping (no dynamic mapping surprises)
- [ ] Indexed asynchronously via the `search-index` queue
- [ ] Search API: full-text over subject/body/recipient, filters on status/sender/campaign/date
- [ ] **`tenantId` filter injected server-side** — never accepted from the client
- [ ] Reconcile command to rebuild the index from Postgres (ES is a derived store, Postgres is truth)
- [ ] Graceful degradation: ES down ⇒ search falls back to a Postgres `ILIKE` query, dashboard keeps working

---

## Phase 8 — Bull Board

- [ ] Mounted at `/admin/queues`
- [ ] **Behind `requireAuth` + `requireRole('ADMIN')`** — this is the endpoint everyone leaves public
- [ ] Read-only in production mode

---

## Phase 9 — Frontend

- [ ] Vite + React + TS + Tailwind, ReachInbox-inspired visual language
- [ ] Reusable primitives: `Button`, `Input`, `Select`, `Table`, `Modal`, `Badge`, `Toast`, `Skeleton`, `EmptyState`
- [ ] Typed API client; every response shape declared in `packages/core`
- [ ] Google login → redirect to dashboard; header shows name, email, avatar; logout
- [ ] Tabs: Scheduled · Sent · Senders · Search
- [ ] Compose modal: subject, body, CSV/TXT upload with detected-address count, start time, gap, hourly limit
- [ ] ⭐ **Delivery Planner panel** — live forecast + per-window bar chart, recomputed on every change via the shared `planSchedule()`
- [ ] Sender health panel with circuit-breaker state
- [ ] Connect-Slack button + connection status
- [ ] Loading skeletons, empty states, error toasts throughout

---

## Phase 10 — Hardening & docs

- [ ] Integration tests: full schedule → send → index cycle against real Postgres/Redis
- [ ] Load test: 1,000 recipients, assert window distribution matches the forecast exactly
- [ ] Restart test, scripted and repeatable
- [ ] README finalised with setup, architecture, and feature-to-requirement mapping
- [ ] [`06-DEVLOG.md`](./06-DEVLOG.md) — what broke and how it was fixed
- [ ] Assumptions & trade-offs written up
- [ ] Demo video script (≤ 5 min)

---

## Demo video running order (5 min)

| Time | Beat |
|------|------|
| 0:00 | Google login → dashboard |
| 0:30 | Compose 1,000 leads → **Delivery Planner forecast appears live** |
| 1:15 | Schedule → Scheduled tab fills → Bull Board shows delayed jobs |
| 2:00 | Emails start sending → Sent tab + Ethereal preview link |
| 2:45 | **Restart:** `docker compose restart api worker` → future sends still fire, nothing duplicated |
| 3:30 | Drop hourly limit → limit hit → **live Slack message** → jobs roll to next window |
| 4:15 | Kill a sender's SMTP → circuit opens → traffic reroutes → Slack alert |
| 4:45 | Elasticsearch search across sent mail |
