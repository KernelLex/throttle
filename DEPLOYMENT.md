# Deployment — Render + Vercel + Neon + Redis Cloud

Getting Throttle onto a live URL, free.

**Read [§1](#1-the-one-thing-that-will-break-your-deploy) first.** It is the failure that
wastes the most time, and it looks like a bug rather than a config mistake.

---

## The stack

| Layer | Service | Free tier |
|---|---|---|
| Frontend | **Vercel** | Unlimited static, never sleeps |
| API + worker | **Render** web service, `ROLE=both` | 750 instance-hrs/mo (744 = 24/7) |
| Postgres | **Neon** | 0.5 GB |
| Redis | **Redis Cloud** | 30 MB |
| Elasticsearch | *skipped* | Postgres fallback is built in |

### ⚠️ Not Turso

The brief mandates **MySQL or PostgreSQL**. Turso is libSQL (a SQLite fork), so it fails
that requirement outright — and the schema would not port: it uses native Postgres
`enum` types (SQLite has none), `@db.Text`, JSONB for the stored plan summary, and
`mode: 'insensitive'` for the search fallback.

Neon is the drop-in: same free-tier convenience, real Postgres, **zero code changes**.

---

## 1. The one thing that will break your deploy

**Cross-site cookies.**

`throttle.vercel.app` and `throttle-api.onrender.com` are different sites. Browsers
**refuse to send `SameSite=Lax` cookies on cross-site fetch requests** — so login appears
to succeed, then every subsequent API call is unauthenticated and the user is bounced
back to the login screen.

It presents as "the session is broken", not "the config is wrong", which is why it eats
hours.

### The fix: proxy /api through Vercel

[`apps/web/vercel.json`](apps/web/vercel.json) rewrites `/api/*` to the Render service.
The browser then only ever talks to the Vercel origin, so:

- everything is **same-origin** → cookies work with the safer `Lax` setting
- **CORS is not involved at all**
- one domain to register with Google and Slack

```
Browser ──▶ throttle.vercel.app/api/auth/me
                     │ (Vercel rewrite, server-side)
                     ▼
            throttle-api.onrender.com/api/auth/me
```

**Update the destination host** in `vercel.json` to your actual Render URL after step 3.

### The alternative, if you cannot proxy

Set `COOKIE_SAMESITE=none` on Render and list the Vercel origin in
`CORS_ALLOWED_ORIGINS`. This works, but it is strictly weaker: `SameSite=None` means
CSRF protection rests entirely on the double-submit token. Prefer the proxy.

---

## 2. Databases

### Neon

1. <https://neon.tech> → sign up → **Create project** `throttle`
2. Copy the connection string — keep **`?sslmode=require`**, Neon rejects unencrypted
   connections and omitting it produces a TLS error that reads like a network fault

### Redis Cloud

1. <https://redis.io/try-free/> → free Essentials (30 MB) → create database
2. **Configuration** tab → public endpoint, username (`default`), password
3. Assemble: `redis://default:PASSWORD@host:PORT`
   — the port from the endpoint, **not** 6379

> **Persistence:** the free tier may not allow AOF. This does **not** break the restart
> guarantee — Postgres is the source of truth, and `runStartupRecovery()` re-enqueues
> everything on boot. A completely wiped Redis still recovers. That is a stronger
> property than "Redis persisted it", and worth demonstrating.

---

## 3. Render (API + worker)

1. <https://render.com> → **New** → **Blueprint** → connect your repo
2. Render reads [`render.yaml`](render.yaml) and creates `throttle-api`
3. Fill the `sync: false` variables in the dashboard:

| Variable | Value |
|---|---|
| `DATABASE_URL` | Neon string (with `?sslmode=require`) |
| `REDIS_URL` | Redis Cloud string |
| `ENCRYPTION_KEY` | **exactly 64 hex chars** — `openssl rand -hex 32` |
| `API_BASE_URL` | `https://YOUR-APP.vercel.app` ← the **Vercel** domain |
| `WEB_BASE_URL` | `https://YOUR-APP.vercel.app` |
| `CORS_ALLOWED_ORIGINS` | `https://YOUR-APP.vercel.app` |
| `GOOGLE_CLIENT_ID` / `SECRET` | from Google Console |
| `SLACK_CLIENT_ID` / `SECRET` / `SIGNING_SECRET` | from Slack |

> `API_BASE_URL` is the **Vercel** domain, not the Render one. With the proxy the browser
> never sees Render, and OAuth redirect URIs must match what the browser actually visits.

> **`ENCRYPTION_KEY` must never change after seeding.** It encrypts SMTP passwords;
> rotating it makes existing senders undecryptable.

4. Deploy, then run migrations from the Render **Shell** tab:

```bash
npx prisma migrate deploy --schema apps/api/prisma/schema.prisma
npm run db:seed -w @throttle/api
```

---

## 4. Vercel (frontend)

1. <https://vercel.com> → **Add New** → **Project** → import the repo
2. **Root Directory**: `apps/web`
3. Vercel detects the npm workspace and Vite automatically
4. Environment variable:

| Variable | Value |
|---|---|
| `VITE_API_URL` | **empty string** |

> Empty is deliberate, not an oversight. The API client falls back to a relative path,
> so requests go to `/api/...` on the Vercel origin and hit the rewrite. Setting it to
> the Render URL would bypass the proxy and reintroduce the cross-site cookie problem.

5. Deploy → note your domain → **put it into `vercel.json`'s rewrite destination and the
   Render env vars**, then redeploy both

---

## 5. OAuth redirect URIs

Both must point at the **Vercel** domain.

**Google** — Console → Credentials → your client → Authorised redirect URIs:
```
https://YOUR-APP.vercel.app/api/auth/google/callback
```

**Slack** — api.slack.com/apps → OAuth & Permissions → Redirect URLs:
```
https://YOUR-APP.vercel.app/api/slack/callback
```

Keep the `localhost:4000` entries alongside them so local development still works — both
services accept multiple URIs.

Also move the Google consent screen out of **Testing** (→ **Publish app**) or add every
reviewer as a test user; otherwise they hit `403: access_denied`.

---

## 6. Keeping it awake

Render free services **spin down after 15 minutes** without traffic, with a ~1 minute cold
start.

Emails are not lost — the reconciler re-enqueues from Postgres on wake and re-spaces the
backlog — but they send **late**, which is bad for a live demo.

**Fix:** <https://uptimerobot.com> (free) → HTTP monitor on
`https://YOUR-APP.vercel.app/healthz`, interval **5 minutes**.

> **Is this cron?** No. The brief's constraint is about how *emails are scheduled* —
> no `node-cron`, no `agenda`, no BullMQ `repeat:`. A keep-alive ping is infrastructure
> monitoring and touches no application scheduling logic. Worth a line in your README so
> the question never arises.

**Instance hours:** 750/month free. 24/7 for 31 days is 744. One service fits; a second
would exceed it — which is exactly why `ROLE=both` runs the worker inside the web process.

---

## 7. Verify

```bash
curl https://YOUR-APP.vercel.app/healthz
curl https://YOUR-APP.vercel.app/readyz
```

Expect `postgres: ok`, `redis: ok`, `elasticsearch: down` — the last is expected and does
not affect readiness (`ELASTICSEARCH_REQUIRED=false`).

Then in the browser:

1. Sign in with Google → lands on the dashboard
2. Header shows your name, email and avatar
3. **Connect Slack** → pick a channel → a test message arrives immediately
4. Compose a campaign → the Delivery Planner forecast appears live
5. Schedule → Scheduled tab fills
6. Wait → Sent tab fills, each row with an Ethereal **View email ↗** link
7. `/admin/queues` → Bull Board (ADMIN only)

### Demonstrating the restart guarantee

```
1. Schedule ~20 emails spread over 10 minutes
2. Render dashboard → Manual Deploy → Restart
3. Watch: overdue emails send exactly ONCE, future ones stay on schedule
```

The server log shows the recovery explicitly:

```
Running startup recovery…
Startup recovery complete — future sends will fire at the correct time
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Login succeeds then instantly signs out | Cross-site cookie blocked | The Vercel proxy is not active, or `VITE_API_URL` points at Render — see §1 |
| `400: redirect_uri_mismatch` | URI mismatch | Must be the **Vercel** domain, exact, no trailing slash |
| `403: access_denied` | Consent screen in Testing | Publish it, or add the user as a test user |
| Prisma TLS error | Missing `sslmode=require` | Append to `DATABASE_URL` |
| `ECONNREFUSED` on Redis | Using 6379 | Use the port from the Redis Cloud endpoint |
| First request takes ~60s | Free-tier cold start | UptimeRobot keep-alive (§6) |
| Boot exits with a config list | Missing/invalid env var | The printed list names each one |
| `ENCRYPTION_KEY` rejected | Not 64 hex chars | `openssl rand -hex 32` |
| Senders fail after a redeploy | `ENCRYPTION_KEY` changed | Restore the original, or re-seed |

---

## Production gaps (worth stating in the README)

This is a free-tier demo deployment, not a production topology:

- **API and worker share a process.** Production splits them so the API can restart
  without interrupting in-flight sends, and so each scales on its own signal.
- **Free tier sleeps.** Mitigated by the reconciler and a keep-alive, not eliminated.
- **No Elasticsearch.** Search runs the Postgres fallback; the UI says so honestly.
- **Single region, single instance.** The rate limiter is already multi-instance safe
  (atomic Lua), so scaling out needs no code change — only a paid plan.
