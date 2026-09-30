# Demo video script

The submission is two pieces back to back:

| | | |
|---|---|---|
| **1** | `brag-output/brag.mp4` | 1:01 — the narrated tour. Plays first, unedited. |
| **2** | Your screen recording | **4:00** — the live demo scripted below. |

**Total 5:01.** The tour already covers what Throttle is, the Delivery Planner, the
shared `planSchedule()`, the circuit breaker and the architecture — so **do not
re-explain any of it.** The four minutes are a live demo against a running system,
and nothing else.

It covers the brief's checklist in order:

| Brief asks for | Where |
|---|---|
| Creating scheduled emails | 0:12 |
| Dashboard with Scheduled and Sent | 0:55 and 2:20 |
| Restart scenario | 1:20 |
| Rate limiting / delay under load | 2:45 |
| Assumptions, shortcuts, trade-offs | 3:15 |

---

## Before you hit record

Run everything **locally**. The deployed instance schedules but cannot send — Render
blocks outbound SMTP on free web services — so the live URL is for showing it
deployed, not for demonstrating delivery.

```bash
# 1. Elasticsearch
C:\Users\AMOG\es\elasticsearch-9.5.4\bin\elasticsearch.bat

# 2. API + worker
npm run dev -w @throttle/api

# 3. Frontend
npm run dev -w @throttle/web
```

`http://localhost:4000/readyz` must show all three `ok`.

**Seed the Sent tab.** Five minutes before recording, compose a small campaign with
the start time set to *now* and let it finish. The Sent tab then has real history
with working Ethereal links and one real Gmail delivery, so it is never empty on
camera. This is the single most important prep step — without it the dashboard looks
half-built for the first two minutes.

**Have open, in this order:**

1. `localhost:5173` — signed in, on the dashboard
2. `localhost:4000/admin/queues` — Bull Board
3. Your Gmail inbox
4. Slack, on `#all-throttle`
5. Terminal A — the API, logs visible
6. Terminal B — in the repo, empty prompt

**Use `demo/leads-demo.csv`**, not `leads.csv`. It is 10 usable addresses plus one
case-variant duplicate and one malformed line, so the parser toast shows real work
*and* the send finishes inside the four minutes. `leads.csv` has 30 and will still be
sending when you need the screen back.

**Turn off notifications.**

---

## 0:00 — 0:12 · Frame it

> "That was the tour. This is the same system running locally, and I'm going to
> schedule a real campaign, kill the server mid-flight, and show that nothing is lost
> and nothing sends twice."

**On screen:** the dashboard, already signed in.

---

## 0:12 — 0:55 · Creating scheduled emails

**Do:** click **Compose**. Subject and a short body.

> "Compose is a full page. Subject, body, and the recipient list."

**Do:** **Upload List** → `demo/leads-demo.csv` → point at the toast.

> "Ten addresses, one duplicate removed, one malformed line skipped. That's parsed in
> the browser for instant feedback and re-parsed on the server when it's submitted —
> the browser's count is convenience, never a security boundary."

**Do:** set **delay `2` seconds**, **hourly limit `50`**.

> "Two seconds between sends, fifty an hour."

**Do:** set the **start time to the next whole minute that is at least 90 seconds
away**. Read it out loud.

> "And I'll schedule it for 14:32 — about ninety seconds from now. Remember that
> time."

**Do:** drag the hourly limit down to `5` and back to `50`, letting the planner chart
re-render.

> "The planner recalculates as I change it — that's the same function the server uses,
> so the forecast isn't an estimate of the schedule, it is the schedule."

**Do:** **Send Later**.

---

## 0:55 — 1:20 · The dashboard

> "Ten jobs, all Scheduled, each with its recipient and its exact send time. Nothing
> has sent yet."

**Do:** switch to Bull Board.

> "And these are the actual BullMQ delayed jobs behind them. This is the live queue
> dashboard — it's behind admin auth, because it exposes recipient addresses and lets
> you retry or delete jobs."

---

## 1:20 — 2:05 · The restart scenario

This is the requirement they care most about. Do not rush it.

> "Now the hard part. Ten emails are scheduled, none have sent, and I'm going to kill
> the process."

**Do:** `Ctrl+C` in Terminal A. **Let the silence sit for three or four seconds** —
the dead prompt on camera is the proof.

> "Process gone. Queue consumer gone. Restarting."

**Do:** in Terminal A, `npm run dev -w @throttle/api`

> "On boot it runs a recovery pass before it consumes anything. A reaper returns any
> job that was stuck mid-send by the crash. A reconciler compares Postgres against
> Redis and re-queues whatever's missing — because Postgres is the source of truth and
> Redis is only the working set. And anything whose hour window closed while it was
> down gets realigned to the current one."

**Point at** the log lines as they appear:

```
Running startup recovery…
Startup recovery complete — future sends will fire at the correct time
```

---

## 2:05 — 2:20 · Still pending

**Do:** back to the dashboard, refresh.

> "Same ten jobs, same scheduled time, still pending. The restart didn't lose them and
> didn't fire them early."

---

## 2:20 — 2:45 · They send

The campaign fires at the time you read out at 0:55. Let it happen on camera.

> "And there they go — two seconds apart, in order."

**Do:** switch to the **Sent** tab as rows move across.

> "Every row links to the real message. These went to Ethereal, which accepts and
> renders mail but never delivers it — that's what makes it safe to test with."

**Do:** click one **View ↗** link. Then switch to Gmail.

> "And this one went through a real Gmail sender over SMTP, so it's actually in my
> inbox. Same pipeline, real delivery."

---

## 2:45 — 3:15 · Rate limiting under load

**Do:** in Terminal B, immediately:

```bash
npx tsx apps/api/src/scripts/testSlackAlert.ts
```

Talk while it runs — it takes fifteen to thirty seconds.

> "One campaign planned properly almost never trips the limiter, because the planner
> already spread it under the budget. The limiter is there to catch drift — and the
> realistic source of drift is two campaigns planned independently into the same hour
> window, each unaware of the other.
>
> So this drops every sender to two an hour, then creates exactly that: campaign A
> fills the budget, campaign B plans into the same window and finds it gone at send
> time."

**Point at** the live counters: `sent … deferred … pending …`

> "Deferred, not dropped and not failed. They roll into the next window, in order."

**Do:** switch to Slack.

> "And one Slack message. The alert itself names how many are waiting and when they
> resume — read that number off the screen, because that many jobs were blocked and
> this is still **one** notification. There's a Redis SETNX guard keyed by sender and
> hour window, so a backlog produces a single message instead of one per job. Without
> it you'd get rate-limited by Slack and somebody would mute the channel."

---

## 3:15 — 3:55 · Assumptions, shortcuts and trade-offs

Slow down here. This section is what separates a demo from an engineering submission.

> "Finally, the honest part.
>
> The central trade-off is planning at schedule time instead of reacting at send time.
> It costs a bigger write when a campaign is created, but it's what makes the forecast
> truthful and keeps delivery in order.
>
> Elasticsearch is optional by design — if the cluster is down, search falls back to
> Postgres, because search being unavailable must never stop email from sending.
>
> Two shortcuts worth naming. Workspaces are keyed by email domain, so everyone at a
> company shares one — a real product needs explicit invitations. And the formatting
> toolbar in compose is presentational: the body is stored and sent as plain text,
> because storing user-supplied HTML is a stored-XSS surface a scheduler doesn't need.
>
> And two deployment limits. Render blocks outbound SMTP on free plans, so the hosted
> instance schedules but can't send — which is why this demo is local. And there's no
> free managed Elasticsearch tier, so search on the live URL runs that Postgres
> fallback. The dashboard labels it rather than hiding it.
>
> Everything else — the architecture, the security posture, and a devlog of what broke
> and how I fixed it — is in the README. Thanks for watching."

---

## If something goes wrong

- **The campaign fires during the restart.** Not a failure — say so and keep going:
  *"Some of those went out while it was restarting, which is the same point — it
  picked up exactly where it left off."*
- **Sends are slow to appear.** Refresh the Sent tab. Check Terminal A for SMTP
  errors; if a sender's circuit has opened, say so — it's a feature, not a fault.
- **Slack doesn't arrive.** The script prints why. Most often the worker isn't running
  or the alert was already debounced this hour window — the script clears the debounce
  itself, so re-running is safe.
- **You overrun.** Cut the Bull Board glance and the Gmail inbox. Never cut the
  restart or the trade-offs.

---

## If you're running short

Cut in this order:

1. **The hourly-limit drag at 0:45** — the tour already showed the planner reacting
2. **Bull Board** — a two-second glance is enough
3. **The Ethereal preview click** — saying it links to the real message is enough

**Never cut:** the restart, the Slack message, or the trade-offs. Those are three of
the five things the brief explicitly asks for.

---

## Things worth saying out loud

The details that read as judgement rather than feature-listing:

- **"The browser's count is convenience, never a security boundary."**
- **"Postgres is the source of truth; Redis is the working set."**
- **"Deferred, not dropped."**
- **"One message, however many blocked jobs."**
- **"The forecast isn't an estimate of the schedule — it is the schedule."**

## Things to avoid

- Don't re-explain anything the tour video already covered.
- Don't read the README aloud. Show the product working.
- Don't apologise for what isn't finished. State limitations plainly — that's what
  the trade-offs section is for.
- Don't fill the restart silence. The dead prompt is the evidence.
