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

Narration carries the tour; the cue is a bed underneath it, not a score.

- **Voice:** a 17-line narration, one or two lines per scene, anchored to the scene
  it describes. Lines are short on purpose — the synthesiser runs about 2.2 words a
  second, and a line that spills into the next scene is worse than one that ends
  early and lets the visual land. `work/fit.mjs` re-checks every line against the
  next line's start and fails loudly if any of them collide.
- **Bed:** C minor, `i – VI – III – VII`, three times through, sized so the last
  chord change falls on the cut. A detuned three-voice pad over a sub on the root —
  slow and warm, a system idling rather than a soundtrack announcing itself.
- **Pulse:** an eighth-note pluck walking the chord, gapped so it breathes, panned
  side to side. It is the scheduler's cadence, kept well under the voice.
- **Marks:** a soft bell on each chord change lands on the scene cut, so the edit is
  punctuated without a drum hit.
- **Duck:** the bed drops to 20% under speech, opening 180ms early so no first word
  is buried, and releasing over 450ms so it does not pump. The envelope is derived
  from the same timeline that places the voice, so the music cannot rise over a line
  that moved.
- **Mix:** the voice gets a presence lift above 1.8kHz — the synthesiser is 22kHz and
  dull, and a little top makes the words carry without raising the level. The whole
  mix goes through a soft `tanh` limiter, then two-pass linear loudness
  normalisation to −15 LUFS with true peak under −1.3 dBFS. In the 300–3400Hz speech
  band the voice sits 13–16dB above the bed.


## Every frame postable

The held frames are the ones worth freezing: the settled forecast headline, the
split `planSchedule()` diagram, the full budget meter mid-rollover, the closing
wordmark.
