# Throttle — launch video plan

**Tone:** `polished` — serious, restrained, long holds, soft fades.
**Format:** 1920×1080, 30fps · **Duration:** 20s (600 frames)

---

## The angle

Most schedulers tell you what happened. Throttle tells you what *will* happen —
before you send anything.

The genuine differentiator is that the forecast is not an estimate: the same
`planSchedule()` runs in the browser to draw the chart and on the server to write
the schedule. The video's whole job is to make that land visually — **the chart you
see before clicking Schedule is the schedule.**

## The hook (first 2 seconds)

One line, in the product's own type, on white:

> **1,000 emails. 3 senders. 50 an hour.**

Then the question resolves beneath it. The viewer answers it in their head before
we show it, which is what buys the next eighteen seconds.

## Highlights

1. **The Delivery Planner** — forecast bars build window by window, headline
   resolving to *7 hour windows · finishes in 6h 40m*. Most screen time; it is the
   differentiator.
2. **The rate limit holding** — a sender fills its hourly budget and the surplus
   visibly rolls into the next window. Nothing dropped. The brief's hardest
   requirement, shown rather than claimed.
3. **Restart survival** — the process dies mid-campaign and the schedule survives,
   because Postgres is the source of truth and the reconciler rebuilds Redis on boot.

## The punchline

> **Nothing dropped. Nothing sent twice.**

Then the wordmark and the URL.

## Visual identity — the shipped UI's own

Taken verbatim from `apps/web/src/index.css`, so the video is drawn in the product's
actual palette rather than an approximation of it.

| Role | Value |
|---|---|
| Canvas / surface | `#ffffff` · `#f7f7f8` · `#f0f0f1` |
| Ink | `#1a1a1a` · secondary `#5f6368` · muted `#8a8d91` |
| Accent | `#00a63e` · tint `#e7f7ed` |
| Pending pill | bg `#fdefd9` · ink `#a15c07` |
| Series | `#00702a` · `#00a63e` · `#4cc274` · `#8dd9a8` |
| Type | Inter, the UI's own face |

Light, green, generous whitespace — matching the Figma the product was built to.
The accent does the same three jobs it does in the app: primary action, outline
button, selected state. Nothing decorative.

## Storyboard — 20.0s

| # | Scene | In | Dur | What happens |
|---|-------|----|-----|--------------|
| 1 | **Hook** | 0.0 | 3.0 | White. Three facts land one at a time, then: *"When does the last one land?"* |
| 2 | **Reveal** | 3.0 | 4.5 | The forecast panel fades up. Headline types in, bars build left to right. Settles on *finishes in 6h 40m*. |
| 3 | **Same function** | 7.5 | 3.5 | Split: *browser* ↔ *server*, joined by `planSchedule()`. The claim lands. |
| 4 | **Rate limit** | 11.0 | 3.5 | Budget meter fills to 200/200. The surplus lifts out of the full window into the next. *Deferred, not dropped.* |
| 5 | **Restart** | 14.5 | 2.5 | The scheduled rows blink out — process killed — then return, still counting down. |
| 6 | **Outro** | 17.0 | 3.0 | *Nothing dropped. Nothing sent twice.* → wordmark → URL |

Every line the viewer is meant to read holds settled for at least 0.3s per word,
counted from when the whole line is on screen.

## Sound

Written as one piece rather than music with effects laid over it.

- **Bed:** a soft sine pad in A minor, slowly opening — a system idling, not a
  soundtrack announcing itself.
- **Pulse:** a muted tick every 0.5s from 3.0s. It *is* the scheduler's cadence.
  It falls away at the restart beat and returns after — the whole story in one
  sonic gesture.
- **Marks:** each bar in the build gets a short blip on A–C–E–A, rising with the
  bars, so the chart plays as an arpeggio rather than being scored over.
- **Restart:** near-silence for 400ms, then a single low swell.
- **Mix:** effects ~14dB under the bed, nothing above −3dBFS, gentle low-pass so
  nothing is spiky.

## Every frame postable

The held frames are the ones worth freezing: the settled forecast headline, the
split `planSchedule()` diagram, the full budget meter mid-rollover, the closing
wordmark.
