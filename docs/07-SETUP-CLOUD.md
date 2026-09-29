# Cloud setup (no Docker)

Running Throttle against free hosted Postgres and Redis instead of Docker.
About 15 minutes total. Do the three sections in any order, then paste the values into
`.env`.

> **Already done for you:** `.env` exists with four real generated secrets
> (`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `ENCRYPTION_KEY`, `COOKIE_SECRET`).
> Don't regenerate them — `ENCRYPTION_KEY` in particular encrypts SMTP passwords, and
> changing it after seeding makes existing senders unreadable.

---

## 1. Google OAuth — required, login does not work without it

**A. Create the project**

1. Go to <https://console.cloud.google.com>
2. Project dropdown (top-left) → **New Project**
3. Name it `Throttle` → **Create** → then select it in the dropdown

**B. Configure the consent screen** *(Google forces this before it will issue a client ID)*

4. Left sidebar → **APIs & Services** → **OAuth consent screen**
5. User type: **External** → **Create**
6. Fill only the required fields:
   - App name: `Throttle`
   - User support email: your email
   - Developer contact email: your email
7. **Save and Continue** through *Scopes* (add nothing — the app requests
   `openid email profile`, which are default scopes and need no declaration here)
8. **Test users** → **+ Add Users** → add **your own Google address**
   > ⚠️ Miss this step and you get `Error 403: access_denied` at sign-in. While the app
   > is in *Testing* status, only listed test users may sign in.
9. **Save and Continue** → **Back to Dashboard**

**C. Create the credentials**

10. **APIs & Services** → **Credentials** → **+ Create Credentials** → **OAuth client ID**
11. Application type: **Web application**
12. Name: `Throttle local`
13. Under **Authorised redirect URIs** → **+ Add URI** → paste **exactly**:

```
http://localhost:4000/api/auth/google/callback
```

> This must match character for character — scheme, host, port, path. No trailing slash.
> A mismatch produces `Error 400: redirect_uri_mismatch`, which is the single most common
> failure in this setup. Note it is port **4000** (the API), not 5173 (the frontend) —
> the backend owns the OAuth exchange.

14. **Create** → copy the **Client ID** and **Client Secret**

**D. Paste into `.env`**

```dotenv
GOOGLE_CLIENT_ID=123456789-abcdefg.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxxxxxx
```

---

## 2. Postgres — Neon

1. <https://neon.tech> → **Sign up** (GitHub or Google login is fastest)
2. **Create project** → name `throttle` → pick the region closest to you → **Create**
3. On the project dashboard, find the **Connection string** panel
4. Select **Prisma** from the dropdown if offered, otherwise copy the default URI
5. Copy the string — it looks like:

```
postgresql://neondb_owner:npg_XXXX@ep-cool-name-123456.us-east-2.aws.neon.tech/neondb?sslmode=require
```

**Paste into `.env`, replacing the existing `DATABASE_URL` line:**

```dotenv
DATABASE_URL=postgresql://neondb_owner:npg_XXXX@ep-....neon.tech/neondb?sslmode=require
```

> Keep `?sslmode=require`. Neon rejects unencrypted connections, and without it Prisma
> fails with a TLS error that reads like a network problem.

Free tier: 0.5 GB — far more than this needs.

---

## 3. Redis — Redis Cloud

**Why Redis Cloud rather than Upstash:** Upstash's free tier meters commands, and BullMQ
workers issue blocking reads (`BZPOPMIN`) continuously — a worker sitting idle still
consumes quota. Redis Cloud's free tier is a real Redis instance with no command cap,
which is what BullMQ expects.

1. <https://redis.io/try-free/> → sign up
2. Create a **free** subscription (Essentials, 30 MB)
3. Create a database — defaults are fine
4. Open the database → **Configuration** tab
5. Collect three things:
   - **Public endpoint** — e.g. `redis-12345.c1.us-east-1-2.ec2.redns.redis-cloud.com:12345`
   - **Username** — usually `default`
   - **Password** — click the eye icon to reveal

**Assemble the URL and paste into `.env`:**

```dotenv
REDIS_URL=redis://default:YOUR_PASSWORD@redis-12345.c1.us-east-1-2.ec2.redns.redis-cloud.com:12345
```

> Note the format: `redis://username:password@host:port`. The port is the one in the
> endpoint string, **not** 6379.

### About persistence on the free tier

The free tier may not let you enable AOF persistence. **This does not break the restart
guarantee**, because of how the system is designed:

- Postgres is the source of truth for the schedule
- On boot, `runStartupRecovery()` reconciles Redis against Postgres and re-enqueues
  anything missing

So even a completely wiped Redis recovers fully — it just means recovery happens via the
reconciler rather than via Redis's own AOF. That is worth demonstrating in the video:
it is a stronger guarantee than "Redis persisted it."

---

## 4. Elasticsearch — skipped

`ELASTICSEARCH_REQUIRED=false` is already set. The API boots without it and search falls
back to a Postgres `ILIKE` query. The dashboard shows a "search running in degraded mode"
banner so the behaviour is visible rather than silent.

To add it later: a free [Bonsai](https://bonsai.io) cluster, then set
`ELASTICSEARCH_URL` and run `npm run es:reindex` to build the index from Postgres.

---

## 5. Slack — required by the brief's notification spec

1. <https://api.slack.com/apps> → **Create New App** → **From scratch**
2. Name `Throttle`, pick your workspace → **Create App**
3. **OAuth & Permissions** (left sidebar):
   - Scroll to **Scopes** → **Bot Token Scopes** → **Add an OAuth Scope**
   - Add `incoming-webhook`
   - Add `chat:write`
4. Scroll up to **Redirect URLs** → **Add New Redirect URL** → paste **exactly**:

```
http://localhost:4000/api/slack/callback
```

   → **Add** → **Save URLs**
5. **Basic Information** → **App Credentials** → copy all three values

```dotenv
SLACK_CLIENT_ID=1234567890.1234567890
SLACK_CLIENT_SECRET=xxxxxxxxxxxxxxxx
SLACK_SIGNING_SECRET=xxxxxxxxxxxxxxxx
```

You connect it from the dashboard after logging in — **Connect Slack** → pick a channel →
approve. A test message posts immediately, so you get proof it works rather than finding
out when a real alert fails silently.

If Slack is left unconfigured the app runs fine; rate-limit hits simply do not notify.

---

## 6. Run it

```bash
npm run db:migrate     # creates the schema on Neon
npm run db:seed        # provisions 3 Ethereal mailboxes automatically
npm run dev            # API on :4000, dashboard on :5173
```

Then open <http://localhost:5173>.

### Verifying it worked

```bash
curl http://localhost:4000/readyz
```

Expect `postgres: ok`, `redis: ok`, `elasticsearch: down` — the last is expected and does
not affect readiness, because `ELASTICSEARCH_REQUIRED=false`.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Error 400: redirect_uri_mismatch` | Google URI doesn't match exactly | Must be `http://localhost:4000/api/auth/google/callback` — port 4000, no trailing slash |
| `Error 403: access_denied` | Your address isn't a test user | OAuth consent screen → Test users → add yourself |
| Prisma TLS / connection error | Missing `sslmode=require` | Append it to `DATABASE_URL` |
| `ECONNREFUSED` on Redis | Using port 6379 instead of the Redis Cloud port | Use the port from the public endpoint |
| API exits immediately with a config list | A required `.env` value is missing or malformed | The printed list names each offending variable |
| `redirect_uri` mismatch on Slack | Slack redirect URL not saved | Must be `http://localhost:4000/api/slack/callback`, and you must click **Save URLs** |
