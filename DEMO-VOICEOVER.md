# Voiceover script — `demo/throttle-demo-4min.mp4`

Read this over the recorded take. **3:56.** Every cue matches what is actually on
screen, so you can record straight through without watching for surprises.

**A narrated cut already exists** — `demo/throttle-demo-4min-narrated.mp4`, read by
`en-US-AndrewMultilingualNeural` over a sparse bed. Use this file to record your own
voice instead; yours will beat the synthesiser. `demo/voiceover-timings.json` holds the
exact per-line start times that cut uses, which are finer than the section marks below.

Written to **2.5 words a second** and deliberately kept under each slot — roughly 80%
of the available time. The gaps are intentional. Silence over a chart is fine, and
rushing is the one thing that will make this sound worse than it is.

> This is the second half of the submission. The 1:01 tour plays first and already
> explains what Throttle is, so **do not re-introduce the product here.** Open straight
> into the demo.

---

## What the brief asked for, and where it is

| Requirement | Timecode |
|---|---|
| Show creating scheduled emails | **0:11** |
| Dashboard with **Scheduled** emails | **0:45** |
| Dashboard with **Sent** emails | **2:21** |
| Restart: stop server → start again → future emails still send | **1:02 – 2:21** |
| *(Bonus)* rate limiting / delay under load | **2:31** |
| Assumptions, shortcuts, trade-offs | **3:27** |

---

## 0:00 — 0:11 · Empty queue  · *23 words*
*Scheduled tab, empty. Sidebar reads Scheduled 0.*

> "This is the same system running locally. The queue is empty. I'm going to fill it,
> then kill the server while it's working."

---

## 0:11 — 0:18 · Compose · *16 words*
*Subject and body typed, CSV uploaded, toast appears.*

> "Compose takes a subject, a body with merge fields, and a lead list. Ten addresses
> detected."

---

## 0:18 — 0:43 · The Delivery forecast · *55 words*
**The strongest 25 seconds in the video. Let it breathe.**

*The hourly limit is dragged 1 → 2 → 50. The chart redraws each time: three windows,
then two, then one.*

> "This is the delivery forecast. At one email per sender per hour, ten emails spread
> across three hour windows. At two an hour, two windows. At fifty — one window,
> finishing in four seconds.
>
> That chart is computed by the same function the server uses to write the schedule. The
> browser and the scheduler can't disagree."

---

## 0:43 — 0:54 · Scheduled · *17 words*
*Scheduled tab, **10 rows**, amber pending pills with exact send times.*

> "Ten jobs scheduled, each with the exact second it goes out, two seconds apart.
> Nothing has sent yet."

---

## 0:54 — 1:02 · The queues · *15 words*
*Bull Board — campaign-pump, email-send, notifications, search-index.*

> "Behind it, the real BullMQ queues. This is the live queue dashboard, behind admin
> auth."

---

## 1:02 — 1:12 · The kill · *14 words*
*Terminal. `^C`, then a dead prompt.*

> "Now the part that matters. The campaign is mid-flight, and I'm killing the process."

**Then stop talking.** The dead prompt holds for several seconds. That silence is the
evidence — let it sit.

---

## 1:12 — 1:35 · Recovery · *52 words*
*`npm run dev` typed, then the boot log. Two lines come up green.*

> "Restarting. On boot it runs a recovery pass before consuming anything. A reaper
> returns jobs stuck mid-send. A reconciler compares Postgres against Redis and re-queues
> what's missing — Postgres is the source of truth, Redis is the working set.
>
> And that line says *self-chaining delayed job, not cron*."

---

## 1:35 — 1:48 · It kept going · *27 words*
*Dashboard. Scheduled has dropped to 4; Sent has climbed. Some rows read `deferred 1x`.*

> "And it never stopped. Some went out before the kill, the rest are still queued at
> their original times. Nothing lost, nothing fired early, nothing sent twice."

---

## 1:48 — 2:21 · Draining · *72 words*
*The Scheduled list empties live as each email sends.*

> "These are going out now, two seconds apart, in planned order.
>
> Watch the annotations — *deferred one time*, *rerouted to Outreach One*. Deferred means
> a job hit a rate limit at send time and was pushed into the next window rather than
> dropped. Rerouted means the health scorer moved it to a different sender.
>
> None of that was staged. That's the scheduler reacting on a server it had just been
> restarted on."

---

## 2:21 — 2:31 · Sent · *20 words*
*Sent tab. Sidebar reads Sent 47. Every row has a Sent pill.*

> "All delivered. Every row links to the real message — these go to Ethereal, which
> renders mail but never delivers it."

---

## 2:31 — 3:25 · Rate limiting under load · *114 words*
*Terminal running `testSlackAlert.ts`, then a live counter: `sent … deferred … pending`.*

> "Last piece — the rate limiter under load.
>
> One campaign planned properly rarely trips the limiter, because the planner already
> spread it under the budget. The limiter catches **drift** — two campaigns planned
> independently into the same hour window, each unaware of the other.
>
> So this drops every sender to two an hour and creates exactly that. Campaign A fills
> the budget. Campaign B finds it gone at send time.
>
> There — deferred climbing to ten while pending drains. Not dropped, not failed.
> Deferred into the next window, in order.
>
> That also fires one Slack alert. A Redis guard keyed by sender and hour window means
> ten blocked jobs produce one message, not ten."

⚠️ **The Slack window is not in the recording** — it needs a signed-in session. Either
narrate it as written, or cut to your own Slack around **3:05**, where the counter
plateaus.

---

## 3:27 — 3:56 · Trade-offs · *65 words*
*The closing card.*

**Slow right down, and let the card do the work.** It lists ten items; you are naming
three and trusting the viewer to read the rest. Trying to say all of them is what pushes
this section over.

> "Finally, the honest part.
>
> The central trade-off is planning at schedule time instead of reacting at send time. It
> costs a bigger write up front, but it's what makes that forecast truthful.
>
> Elasticsearch is optional — search being down must never stop email sending. And Render
> blocks outbound SMTP on free plans, which is why this demo is local.
>
> The rest is in the README. Thanks for watching."

---

## Lines worth landing

If you only nail five moments, make them these:

- **"That chart is computed by the same function the server uses to write the schedule."**
- **"Postgres is the source of truth; Redis is the working set."**
- **"Nothing lost, nothing fired early, nothing sent twice."**
- **"Deferred, not dropped."**
- **"Ten blocked jobs produce one message, not ten."**

## Two claims not to make

The recording does not support these, so leave them out unless you add the cut yourself:

1. **"It's in my Gmail inbox."** Sender rotation is by health score, so which recipient
   goes out through the real Gmail sender is not deterministic. In this take that
   address was handled by an Ethereal sender, which never delivers.
2. **"None of them had sent when I killed it."** They had — the campaign was already
   draining. What the video proves is *survival mid-flight*, which is the stronger claim
   and is what the script above says.
