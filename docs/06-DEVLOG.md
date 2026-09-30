# Development log — what broke and how it was fixed

> A record of problems hit during the build, their causes, and how they were resolved.
> The reasoning is often more reusable than the fix: several of these are traps that are
> easy to fall into twice.

Entries are newest-last.

---

## 1. The security test passed vacuously

**Severity: high.**

`routeSecurity.test.ts` walks the real Express router stack and asserts that every route
either carries `requireAuth` or appears on an explicit allowlist. It reported 7/7 passing
against 28 discovered routes.

Verification: a deliberately unguarded endpoint was injected.

```ts
app.post('/api/secret-leak', (_req, res) => { res.json({ ok: true }); });
```

**The test still passed.** It was asserting nothing.

**Cause.** Bull Board is mounted with a path:

```ts
app.use('/admin/queues', requireAuth, requireRoleGuard, bullBoardAdapter.getRouter());
```

That places layers named `requireAuth` and `requireRoleGuard` in the **app-level** stack.
The first implementation collected guard names from every non-route layer at the current
level without checking *what path those guards were mounted at*, so it concluded that
`requireAuth` applied to the entire application and every route looked guarded.

**Fix.** Guards are now collected as `{ name, prefix }` pairs, where the prefix comes from
the layer's own mount regexp. A route only inherits a guard whose prefix is a prefix of
its own path:

```ts
const inherited = activeGuards
  .filter((guard) => path === guard.prefix || path.startsWith(`${guard.prefix}/`))
  .map((guard) => guard.name);
```

**Verification.** Both cases re-run: clean tree 7/7 pass; with the unguarded route
injected, 2 tests fail and name `POST /api/secret-leak`.

A security test that has never been observed to fail is not a security test. Every
assertion of the form "X can never happen" is worth verifying by making X happen once.
The earlier version was worse than no test, because it manufactured confidence.

An earlier draft also hardcoded a list of protected route prefixes — a second copy of the
truth, which would have kept passing if someone deleted a `router.use(requireAuth)` line.
That was replaced by real stack inspection at the same time.

---

## 2. `planSchedule()` windows desynchronising from the Redis counters

**Caught in design, before it shipped** — but worth recording because it would have been
very hard to debug later.

**The trap.** The natural way to bucket a schedule is relative to the campaign start:
window 0 is `startAt` to `startAt + 1h`, window 1 the hour after, and so on. Clean, easy
to reason about.

But the Redis rate-limit key is inherently wall-clock based:

```
throttle:rl:{tenant}:{sender}:{floor(epochMs / 3600000)}
```

If the planner buckets from `startAt` and the limiter buckets from the wall clock, a
campaign starting at 10:45 has the planner's "window 0" spanning 10:45–11:45 while the
limiter uses two different buckets (10:00–11:00 and 11:00–12:00). The forecast would say
"50 emails in the first window" and reality would deliver a split across two windows with
two separate quotas.

**Why it would have been nasty.** Everything would *work* — emails send, limits hold,
nothing errors. Only the forecast would be subtly wrong, and only for campaigns not
starting exactly on the hour. That is the kind of bug that gets attributed to "the chart
being approximate".

**Fix.** Both sides import `hourWindowStart()` / `hourWindowKey()` from
`packages/core/src/time.ts`. The planner aligns to wall-clock UTC hours because the
limiter must. The shared import is the enforcement mechanism — there is no second
implementation to drift.

**Consequence handled:** a campaign starting at 10:45 gets only 15 minutes of the 10:00
window. The planner models this with a time cursor (rather than `index / capacity`
arithmetic) and emits a `PARTIAL_FIRST_WINDOW` warning explaining why the first bar is
shorter. Test: *"gives the first window only the capacity its remaining wall time allows"*.

---

## 3. Two copies of Vite in the workspace

**Symptom.** `apps/web` typechecking failed with a 30-line error ending in:

```
Type 'Plugin<any>' is not assignable to type 'PluginOption'.
  Types of property 'apply' are incompatible.
```

Structurally identical types, refusing to unify.

**Root cause.** Two Vite installs:

```
node_modules/vite            5.4.21   ← pulled in by vitest 2.1.x
apps/web/node_modules/vite    6.4.3   ← the app's own
```

`@tailwindcss/vite` hoisted to the root and resolved its `vite` types against **5.4.21**,
while the app was compiled against **6.4.3**. TypeScript treats types from different
copies of a package as distinct even when identical, so the plugin array would not typecheck.

**Fix.** Upgraded `vitest` 2.1.x → 3.2.4 (whose peer range is `^5 || ^6 || ^7`) and pinned
`vite: ^6.4.3` in the root `devDependencies` so npm hoists exactly one copy. Verified:

```
root vite:       6.4.3
nested web vite: none (good - single copy)
```

In a monorepo, a "type is not assignable to itself" error almost always means duplicate
installs rather than a real type problem. Check `node_modules` before debugging types.

---

## 4. `.env` not loading under npm workspaces

**Symptom.** `npm run db:seed` exited with "invalid environment configuration" listing
every variable as missing — while `.env` sat in the repo root, fully populated.

**Two causes at once**, which made it confusing:

1. **npm workspaces set cwd to the package directory.** Scripts run from `apps/api`, while
   `.env` is at the monorepo root, so dotenv's default lookup missed it entirely.
2. **ES module imports are hoisted and run in source order.** Calling `dotenv.config()`
   in a module body runs *after* every import in that file has executed — including
   `config.ts`, which validates the environment at import time and calls `process.exit(1)`.
   The load was happening, just far too late.

**Fix.** [`apps/api/src/loadEnv.ts`](../apps/api/src/loadEnv.ts) performs the load as an
import-time **side effect**, searching upward through candidate paths. Every entry point
imports it first:

```ts
import './loadEnv.js';        // must be first
import { env } from './config.js';
```

In Docker no `.env` exists and the variables are already injected by `env_file`; dotenv
never overrides an existing value, so nothing breaks. The warning only fires when
`DATABASE_URL` is also absent, so the Docker path stays quiet.

---

## 5. `@types/nodemailer` types `getTestMessageUrl()` against the wrong info shape

**Symptom.**

```
Argument of type 'SentMessageInfo' is not assignable to parameter of type
'SESTransport.SentMessageInfo | SMTPTransport.SentMessageInfo'.
  Property 'pending' is missing in SMTPPool.SentMessageInfo
```

**Cause.** Our transports use `pool: true`, so `sendMail()` returns
`SMTPPool.SentMessageInfo`. `getTestMessageUrl()` is typed to accept only the
*non-pooled* `SMTPTransport.SentMessageInfo`, which declares a `pending` field the pooled
shape does not have. A gap in the type definitions, not a real incompatibility — the
function derives the Ethereal URL from the message id and response, and never touches
`pending`.

**Fix.** A narrow, documented cast at the single call site rather than widening anything
to `any`:

```ts
previewUrl: nodemailer.getTestMessageUrl(
  info as unknown as SMTPTransport.SentMessageInfo,
) || null,
```

The comment at that line records *why* the cast is safe, so it does not read as someone
silencing an inconvenient error.

---

## 6. Multer 1.x shipped with known vulnerabilities

**Symptom.** `npm install` warned:

```
npm warn deprecated multer@1.4.5-lts.2: Multer 1.x is impacted by a number of
vulnerabilities, which have been patched in 2.x.
```

**Fix.** Upgraded to `multer@^2.0.2` before any upload code depended on 1.x behaviour.

Given that this endpoint accepts user-uploaded files, additional hardening was applied
beyond the version bump: `memoryStorage` (nothing user-supplied is written to disk),
a hard byte cap, a single-file limit, an extension allowlist, and a NUL-byte content
sniff to reject binaries wearing a `.csv` extension.

Deprecation warnings during install are worth reading rather than scrolling past,
especially for a package sitting directly in an untrusted-input path.

---

## 7. `bull-board` subpath import and `pino-http`'s default export

Two small module-resolution issues under `moduleResolution: NodeNext`, fixed together.

**`@bull-board/api/bullMQAdapter.js` → cannot find module.** The package's `exports` map
declares the key `./bullMQAdapter` with **no extension**. Adding `.js` asks for a subpath
the map does not declare. Fixed by dropping the extension. (Counter-intuitive under
NodeNext, where extensions are normally required — but an `exports` map key is a literal,
not a file path.)

**`pino-http` "this expression is not callable".** Its `index.d.ts` uses
`export default PinoHttp` while the runtime is CommonJS, so NodeNext would not treat the
default import as callable. It also exports `{ PinoHttp as pinoHttp }`, and the runtime
was verified to expose all three forms:

```
module type: function · has .pinoHttp: function · has .default: function
```

Fixed by switching to the named import.

When an import fails under NodeNext, read the package's actual `exports` map and check
the runtime shape. Guessing at extensions costs more time than one
`node -e "console.log(Object.keys(require('pkg')))"`.

---

## 8. Sloppy intersection type in the worker's sender query

**Symptom.** Four type errors in `emailWorker.ts`, all of the form
`Property 'hourlyLimit' does not exist on type 'SenderCredentials'`.

**Cause.** A placeholder return type left in place:

```ts
async function loadSenderPool(
  tenantId: string,
): Promise<SenderCredentials[] & { hourlyLimit: number; minGapMs: number }[]> {
  // ...
  return senders as never;    // ← the red flag
}
```

That intersection is meaningless, and `as never` silenced the mismatch rather than
fixing it. The worker needs SMTP credentials *and* scheduling policy (hourly limit,
min gap).

**Fix.** A real type, and an explicit `select` rather than a bare `findMany`:

```ts
export interface PoolSender extends SenderCredentials {
  hourlyLimit: number;
  minGapMs: number;
}
```

The explicit `select` also means adding a column to the Sender model can never silently
widen what this hot-path query pulls, and makes it obvious at a glance that the encrypted
password is loaded deliberately.

`as never` and `as any` are deferral markers. They should not survive to a
typecheck-clean state: the typecheck passing is exactly what stops anyone noticing them.

---

## 9. Every new workspace had zero senders

**Severity: high — the deployed app looked broken to anyone but the seeder.**

Deployment was green: health checks passing, both OAuth providers enabled, the
Vercel→Render proxy forwarding correctly. The problem surfaced only when asking whether
a second person signing in would find a usable app.

The data:

```
"Demo Workspace"        users: 0   senders: 3
"amogh p's workspace"   users: 1   senders: 0
```

The seed script creates senders inside a `Demo Workspace` tenant. Real tenants are
created on first login, keyed by email domain. **Those two never meet.** So every real
user — including the developer — landed on a dashboard with no senders, unable to
schedule anything, with no obvious next step.

**Why it survived so long.** Every layer tested green in isolation. The seed worked. The
login worked. Tenant isolation worked *correctly* — it was isolating the user from the
seeded data exactly as designed. Nothing was broken; two correct behaviours simply did
not compose.

**Fix.** `ensureTenantHasSenders()` provisions Ethereal mailboxes for any workspace with
none, called from the OAuth callback. It is a no-op once a workspace has senders, so it
fires exactly once, and it never throws: a provisioning failure degrades to "no senders
yet", never to "cannot sign in".

Plus `backfillSenders.ts` to repair existing data: it provisioned senders for the real
workspace and deleted the orphaned `Demo Workspace` whose senders nobody could reach.

Integration bugs live in the gaps between correct components. Seeding and tenant
creation were each right on their own; what went unasked was whether a *new user* could
use the product at all. "Does a first-time visitor reach a working state?" is a test in
its own right, and green health checks say nothing about it.

---

## Open items

- **The full schedule → send → restart cycle has not been driven end to end.** All code
  typechecks and unit tests pass, and the infrastructure is verified independently
  (health, proxy, OAuth redirect, auth guards), but no run has gone from compose through
  to a sent message.
- **No end-to-end browser test** for the login → compose → schedule flow.
- **Campaign pump** (incremental materialisation beyond 5,000 recipients) is wired into
  the queue and config, but its handler is a stub. Campaigns below the threshold are
  materialised in full up front, which covers every realistic demo size.
