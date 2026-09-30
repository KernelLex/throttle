# Throttle — Project Overview

> **The "what is done, what is where" file.** Start here.
> Updated as work lands. Last updated: 2026-09-30.

Throttle is a production-grade email job scheduler: it accepts campaigns over an API,
spreads them across multiple senders under per-sender hourly rate limits, sends via
SMTP, survives restarts without losing or duplicating a single send, and exposes a
dashboard for all of it.

Built for the ReachInbox full-stack assignment.

---

## Current status

| Phase | Area | Status |
|-------|------|--------|
| 0 | Foundation, Docker, config | ✅ Done |
| 1 | `packages/core` shared planner | ✅ Done — **25/25 tests passing** |
| 2 | Prisma schema & persistence | ✅ Done — schema + seed (auto-provisions Ethereal) |
| 3 | Auth & security spine | ✅ Done — **7/7 route-security tests passing** |
| 4 | Scheduler core | ✅ Done — worker, queues, reconciler, reaper |
| 5 | Rate limiting & Slack | ✅ Done — atomic Lua limiter, debounced alerts |
| 6 | Circuit breaker | ✅ Done |
| 7 | Elasticsearch | ✅ Done — with Postgres fallback |
| 8 | Bull Board | ✅ Done — ADMIN-gated, fails closed |
| 9 | Frontend | ✅ Done — dashboard, compose, Delivery Planner, health panel |
| 10 | Hardening & docs | ✅ Done |

**Deployed:** <https://throttle-delta.vercel.app> (Vercel) → `throttle-api-9jxt.onrender.com`
(Render) → Neon Postgres + Redis Cloud, all in Singapore.

**Verification at last run:**

```
packages/core   25 tests passed
apps/api         7 tests passed
typecheck        all 3 packages clean (strict + noUncheckedIndexedAccess)
web build        703 modules, 2.57s
```

### Verified end to end

- **Google OAuth** — sign-in works on the deployed URL and locally.
- **Campaign scheduling** — campaigns plan, persist and enqueue; jobs fire on time.
- **Real SMTP delivery** — a Gmail sender delivers to a real inbox; Ethereal senders
  render at preview URLs, linked from every Sent row.
- **Rate limiting** — a forced hourly-limit hit deferred 15 jobs and dropped none.
- **Slack alert** — a real message was delivered to `#all-throttle` on that hit
  (`kind: RATE_LIMIT_HIT`, `delivered: true`). One message for 15 blocked jobs,
  which is the SETNX debounce working.
- **Circuit breaker** — opened after five consecutive SMTP failures during an
  unplanned outage; Redis and Postgres agreed on the state and traffic rerouted.
- **Elasticsearch** — index created against a local 9.5.4 cluster; scheduled and sent
  email both indexed.

### Known limitations

- **The deployed instance cannot send email.** Render blocks outbound SMTP ports
  (25/465/587) on free web services, silently. Scheduling, queueing, rate limiting,
  deferral and restart recovery all work there; only the SMTP hop fails. Any paid
  instance unblocks it with no code change. Sending is demonstrated locally.
- **Search on the deployed URL uses the Postgres fallback.** There is no free managed
  Elasticsearch tier; the code path is complete and demonstrated against a local cluster.
- **Campaign pump handler is a stub.** Campaigns are materialised in full up front,
  which covers every size up to the 50k cap.
- **No add-sender UI for MEMBERs.** Only workspace ADMINs can add a sending identity.


---

## Repository map

```
throttle/
├── docs/                          ← you are here
│   ├── 00-PROJECT-OVERVIEW.md     this file — status + map
│   ├── 01-PLAN.md                 phased build plan
│   ├── 02-TECH-STACK.md           every dependency and why
│   ├── 03-ARCHITECTURE.md         how scheduling/persistence/limits work
│   ├── 04-SECURITY.md             threat model, endpoint-by-endpoint
│   ├── 05-SCALABILITY.md          behaviour at 1k / 100k / 1M
│   └── 06-DEVLOG.md               what broke and how it was fixed
│
├── packages/core/                 ⭐ shared by backend AND frontend
│   └── src/
│       ├── planner.ts             ⭐ planSchedule() — the heart
│       ├── planner.test.ts        25 tests, incl. the brief's own example
│       ├── time.ts                hour-window maths (shared with the limiter)
│       ├── leads.ts               CSV/TXT parsing, dedup, validation
│       ├── types.ts               domain types
│       ├── api-types.ts           API response contracts
│       ├── schemas.ts             Zod schemas (shared validation)
│       └── constants.ts           bounds, queue names, Redis key builders
│
├── apps/api/
│   ├── prisma/schema.prisma       data model
│   └── src/
│       ├── config.ts              Zod-validated env; crashes on bad config
│       ├── lib/                   logger, redis, prisma, crypto, errors
│       ├── auth/                  tokens.ts (JWT + rotation), google.ts (OAuth+PKCE)
│       ├── middleware/            auth, csrf, validation, error handling
│       ├── mailer/                transport.ts (SMTP pool), send.ts
│       ├── queues/                BullMQ queue definitions
│       ├── scheduler/
│           ├── rateLimiter.ts     ⭐ atomic Lua token bucket
│           ├── senderHealth.ts    ⭐ circuit breaker + health scoring
│           ├── emailWorker.ts     ⭐ the send pipeline
│           └── notificationGuards.ts  Slack debounce
│
└── apps/web/                      React + Vite + Tailwind (not started)
```

---

## Where to look for each requirement

| Brief requirement | Implementation |
|---|---|
| BullMQ delayed jobs, no cron | [`queues/index.ts`](../apps/api/src/queues/index.ts) — note the explicit refusal to use `repeat:` |
| Survives restart | [`maintenance.ts`](../apps/api/src/scheduler/maintenance.ts) — reaper + reconciler at boot; Redis AOF |
| No duplicate sends | Three layers — see [`emailWorker.ts`](../apps/api/src/scheduler/emailWorker.ts) header |
| Worker concurrency | `WORKER_CONCURRENCY` → `emailWorker.ts` |
| Min delay between sends | **2 seconds** default, `MIN_DELAY_BETWEEN_EMAILS_MS`, enforced in Lua |
| Emails per hour | `MAX_EMAILS_PER_HOUR_PER_SENDER` → [`rateLimiter.ts`](../apps/api/src/scheduler/rateLimiter.ts) |
| Multi-worker safety | Every check-and-increment is a single Lua script |
| Never drop jobs | `moveToDelayed()` — does not consume a retry attempt |
| Slack on limit hit | [`notificationGuards.ts`](../apps/api/src/scheduler/notificationGuards.ts) — one alert per sender per window |
| Elasticsearch | [`search/elasticsearch.ts`](../apps/api/src/search/elasticsearch.ts) — async indexing, Postgres fallback |
| Bull Board | `/admin/queues` — `requireAuth` + `requireRole(ADMIN)`, flag fails closed |

---

## Getting unblocked

Docker Desktop is not installed. Two options:

**Install Docker Desktop** (recommended — matches how the reviewer will run it):
<https://www.docker.com/products/docker-desktop/> · enable WSL 2 backend · then
`npm run infra:up`.

**Or use free cloud services** and skip Docker entirely — fill these into `.env`:
- Postgres → [Neon](https://neon.tech) free tier
- Redis → [Upstash](https://upstash.com) free tier (**verify AOF/persistence is on**)
- Elasticsearch → [Bonsai](https://bonsai.io) free tier, or set
  `ELASTICSEARCH_REQUIRED=false` and run on the Postgres search fallback

---

## Conventions worth knowing

- **Postgres is the source of truth.** Redis holds the working set, Elasticsearch a
  derived index. Both are rebuildable from Postgres; neither is rebuildable from the
  other. That ordering is why restart recovery is tractable.
- **Nothing is hardcoded.** Every limit flows env → `config.ts` → per-sender DB override.
- **Config errors crash at boot.** A scheduler silently running at the wrong rate is
  worse than one that refuses to start.
- **Comments explain *why*, not *what*.** If a line looks odd, the comment says what
  goes wrong without it.
