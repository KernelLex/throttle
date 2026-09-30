# Demo video script

A 5-minute recording covering everything the brief asks to see, plus the two features
that go beyond it.

**Target: 4:30.** Leaves margin without rushing.

---

## Before you hit record

Run everything **locally**. The deployed instance cannot send email — Render blocks
outbound SMTP ports on free plans — so the live URL is for showing it deployed, not for
demonstrating delivery.

```bash
# 1. Elasticsearch (if not already running)
C:\Users\AMOG\es\elasticsearch-9.5.4\bin\elasticsearch.bat

# 2. API + worker
npm run dev -w @throttle/api

# 3. Frontend
npm run dev -w @throttle/web
```

Check `http://localhost:4000/readyz` shows all three `ok`.

**Have open in tabs, in this order:**

1. `localhost:5173` — signed out, on the login screen
2. `localhost:4000/admin/queues` — Bull Board
3. Slack, on `#all-throttle`
4. A terminal running the API, logs visible
5. A second terminal, in the repo, for the restart

**Prepare a `leads.csv`** with ~30 addresses. Include your own Gmail as the first line
so you can show a real delivery.

**Turn off notifications.** Nothing kills a demo like a Teams popup.

---

## 0:00 — 0:25 · What it is

> "This is Throttle — an email job scheduler built for the ReachInbox assignment.
>
> It takes a campaign, spreads it across multiple senders under per-sender hourly rate
> limits, sends over SMTP, and survives restarts without losing or duplicating a single
> send.
>
> The thing I want to show first is the part I think is most interesting, because it
> shapes everything else."

**On screen:** the README, scrolled to the architecture diagram.

---

## 0:25 — 1:05 · The core design decision

> "Most schedulers decide rate limiting reactively — a job wakes up, checks a counter,
> and bounces if it's over the limit. That works, but a thousand jobs wake together, 950
> bounce, and delivery order is scrambled.
>
> Throttle inverts that. At schedule time a pure function called `planSchedule` assigns
> every recipient a sender, an hour window and an exact send time. Those go into Postgres
> and into BullMQ as delayed jobs.
>
> At send time the worker re-checks an atomic Redis counter — but that's a *guard*, not
> the planner. It only fires when reality has drifted from the plan.
>
> And because `planSchedule` is a pure function in a shared package, the browser imports
> the same function to draw the forecast. So the chart a user sees before scheduling
> isn't an estimate of the schedule — it *is* the schedule."

**On screen:** `packages/core/src/planner.ts`, then the mermaid diagram showing the
`planSchedule()` arrow going to both the browser and the server.

---

## 1:05 — 1:25 · Login

> "Real Google OAuth — authorization code flow with PKCE, handled entirely on the
> backend so no secret ever reaches the browser. The session is an httpOnly cookie with
> a rotating refresh token."

**Do:** click **Login with Google**, pick your account, land on the dashboard.
**Point at:** name, email, avatar in the sidebar.

---

## 1:25 — 2:15 · Compose, and the Delivery Planner

> "Compose is a full page, matching the Figma."

**Do:** click **Compose**. Fill in subject and body.

> "I upload a CSV of leads and it tells me how many addresses it found — parsed in the
> browser for instant feedback, then re-parsed server-side, because the browser's count
> is convenience and never a security boundary."

**Do:** **Upload List** → pick `leads.csv` → point at *"30 email addresses detected"*.

> "Delay between emails, hourly limit, start time."

**Do:** set delay `2`, hourly limit `5`, start time about a minute out.

> "And this is the Delivery Planner. It's running that same `planSchedule` function
> locally, so as I change the hourly limit, the forecast updates — how many windows it
> takes, how it splits across senders, and exactly when the last email lands."

**Do:** change the hourly limit from 5 to 50 and back. **Let the chart re-render on
camera** — the live recalculation is the point.

> "With a low limit it spreads across several hour windows. That's the answer to
> 'what happens when a thousand emails are scheduled for the same time' — they never all
> come due at once, because they were never planned that way."

**Do:** **Send Later**.

---

## 2:15 — 2:45 · Scheduled and Sent

> "The Scheduled tab fills immediately. Each row shows the recipient, the status pill
> with its scheduled time, and the campaign."

**Do:** switch to Bull Board.

> "And these are the actual BullMQ delayed jobs — this is the live queue dashboard the
> brief asks for. It's behind admin auth; it exposes recipient addresses and lets you
> retry or delete jobs, so it isn't something to leave open."

**Do:** back to the dashboard, wait for sends, switch to **Sent**.

> "As they send they move to Sent. Every row links to the Ethereal preview — Ethereal
> accepts mail and renders it but never delivers, which is what makes it safe to test
> with. And this one went through a real Gmail sender, so it's actually in my inbox."

**Do:** click a **View ↗** link. Show your inbox if a real one landed.

---

## 2:45 — 3:20 · Rate limiting and the Slack alert

> "Now the rate limit. I've set the hourly limit deliberately low, and I'm running a
> script that creates two campaigns competing for the same budget — because with the
> planner doing its job, a single campaign rarely trips the limiter. The limiter exists
> to catch drift, and two campaigns planned independently is the realistic source of it."

**Do:** run `npx tsx apps/api/src/scripts/testSlackAlert.ts`

> "The first campaign consumes the budget. The second finds it gone at send time, so
> those jobs are deferred into the next window — not dropped, not failed, and in order."

**Do:** switch to Slack as the message lands.

> "And there's the Slack notification. This came from a real OAuth install — the user
> clicks Connect Slack, approves, and we store an encrypted webhook per workspace.
>
> The important detail: fifteen jobs were blocked and this is **one** message. There's a
> Redis SETNX guard keyed by sender and hour window, so a backlog produces a single alert
> instead of fifteen. Without it you'd get rate-limited by Slack and the channel muted."

**On screen:** the Slack message, showing sender, backlog count, resume time.

---

## 3:20 — 3:55 · Restart survival

> "The hard requirement: survive a restart without losing or re-sending anything."

**Do:** schedule a small campaign a couple of minutes out. Show the Scheduled rows.

> "There are the pending jobs. Now I kill the worker."

**Do:** `Ctrl+C` in the API terminal. Let it sit for a few seconds.

> "Process gone. Restarting."

**Do:** `npm run dev -w @throttle/api`

> "On boot it runs a recovery pass. A reaper returns any job stuck mid-send by the crash,
> and a reconciler compares Postgres against Redis and re-queues anything missing —
> because Postgres is the source of truth and Redis is just the working set.
>
> If a job came due while it was down, it fires immediately. If it's still in the future,
> it fires at the original time. And nothing sends twice."

**Point at** the log lines: `Running startup recovery…` → `Startup recovery complete`.

**Do:** let a scheduled email send after the restart. Show it in Sent.

> "Three separate things prevent a double send: BullMQ refuses a duplicate job id, the
> worker claims each job with an atomic compare-and-swap in Postgres so only one worker
> can ever transition it, and there's a unique constraint on campaign plus recipient as
> a last line of defence."

---

## 3:55 — 4:20 · The second advanced feature

> "One more thing beyond the brief. Instead of round-robin across senders, each one is
> scored: remaining hourly budget times one minus its recent failure rate. If a sender
> fails five times in a row its circuit breaker opens, it's taken out of rotation, and
> traffic reroutes to healthy senders."

**Do:** open the sender health panel.

> "This actually proved itself by accident. When I deployed to Render, every send started
> timing out — Render blocks outbound SMTP on free plans. The breaker opened after five
> consecutive failures, traffic rerouted, and every queued job was deferred rather than
> failed. The failure path got tested by a real outage rather than a staged one."

---

## 4:20 — 4:30 · Close

> "Elasticsearch indexes both scheduled and sent email and degrades to a Postgres query
> if the cluster is down, so search being unavailable never stops sending.
>
> No cron anywhere — not even BullMQ's `repeat` option, which is cron-backed. Recurring
> work is a delayed job that re-enqueues itself.
>
> The README has the architecture, the trade-offs, and a devlog of what broke and how I
> fixed it. Thanks for watching."

---

## If you're running short

Cut in this order:

1. **0:25–1:05 design section** — compress to one sentence, let the chart make the point
2. **The circuit breaker** — mention it, skip the panel
3. **Bull Board** — a two-second glance is enough

**Never cut:** the Delivery Planner recalculating, the Slack message arriving, or the
restart. Those are the three the brief cares most about.

---

## Things worth saying out loud

These are the details that read as judgement rather than feature-listing:

- **"The browser's count is convenience, never a security boundary."**
- **"One message, fifteen blocked jobs."**
- **"Postgres is the source of truth; Redis is the working set."**
- **"Deferred, not dropped."**
- **"Not even BullMQ's `repeat` — it's cron-backed."**

## Things to avoid

- Don't read the README aloud. Show the product working.
- Don't apologise for what isn't finished. State limitations plainly if they come up.
- Don't rush the Delivery Planner. It's the strongest thing here; give it the time.
