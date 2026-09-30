# Tech stack

Every dependency, why it is here, and what was considered instead. Nothing is in this
list because it is popular.

---

## Shape of the repository

**npm workspaces monorepo.** Three packages:

```
packages/core   shared domain logic — imported by BOTH backend and frontend
apps/api        Express API + BullMQ worker (one codebase, two roles)
apps/web        React dashboard
```

The monorepo exists for **one specific reason**: `planSchedule()` must be the same
function on both sides. Publishing it to npm would work but adds a release step to every
change; copying it into both apps guarantees they drift. A workspace package gives a
single source with zero ceremony.

The second benefit fell out for free: the frontend imports its API response types from
`@throttle/core`, so a change to a backend response shape becomes a **compile error in
the frontend** rather than an `undefined` at runtime.

*Considered:* Turborepo / Nx — real caching benefits, but this repo has three packages
and a five-second build. Not worth the config surface.

---

## Backend

| Package | Why |
|---|---|
| **TypeScript 5.7** | Required by the brief. Run with `strict` **plus** `noUncheckedIndexedAccess` — the latter catches the `array[0]` -> `undefined` class of bug, which matters in a planner doing a lot of index arithmetic. |
| **Express 4.21** | Required by the brief. Deliberately 4.x, not 5.x: `@bull-board/express` and several middleware packages still target 4, and this project's value is not in being on the newest major. |
| **BullMQ 5.34** | Required by the brief. **`repeat:` is never used** — it is cron-expression-backed and the brief forbids cron. Recurring work uses self-chaining delayed jobs. |
| **ioredis 5.4** | BullMQ's expected client, and the one that supports `defineCommand()` for registering Lua scripts as first-class commands with automatic `EVALSHA` caching. The rate limiter depends on that. |
| **Prisma 6.1** | Mature migration tooling and generated types. **Not used for one thing:** the atomic job claim is raw SQL, because Prisma cannot express `UPDATE ... WHERE <status guard> RETURNING *` and that statement is what prevents double sends. |
| **PostgreSQL 16** | Source of truth. Chosen over MySQL for partial indexes, `RETURNING` on `UPDATE`, and native JSONB for the stored plan summary. |
| **Zod 3.24** | Validates request bodies *and* the environment at boot. Shared with the frontend, so the form shows the same error the API would return. |
| **Nodemailer 6.9** | The SMTP client for Node, and it has first-class Ethereal support — `createTestAccount()` provisions a throwaway mailbox, which is what makes `npm run db:seed` need zero manual setup. |
| **@elastic/elasticsearch 8.16** | Required by the brief. Treated as a **derived store**: the app boots without it and search degrades to a Postgres `ILIKE` query. |
| **Pino 9.6** | Fast structured logging with **path-based redaction** — the reason it was chosen over Winston. This app handles SMTP passwords and OAuth tokens; redacting by path means a careless `logger.info({ req })` cannot leak an `Authorization` header. |
| **jsonwebtoken 9** | Access tokens. Algorithm is **pinned to HS256** at verification, so a token cannot nominate `none` via its own header. |
| **helmet 8** | Security headers. |
| **express-rate-limit 7.5 + rate-limit-redis** | HTTP rate limiting. The **Redis store is the point** — an in-memory store gives each API instance its own allowance, multiplying the real limit by the instance count. |
| **multer 2.0** | File uploads. **2.x specifically** — 1.x has unpatched CVEs ([devlog §6](./06-DEVLOG.md)). |
| **@bull-board/express 6.5** | The live queue dashboard the brief asks for. Mounted behind `requireAuth` + `requireRole('ADMIN')`. |
| **dotenv 16** | Loads `.env` from the monorepo root; npm workspaces set cwd to the package dir ([devlog §4](./06-DEVLOG.md)). |

### Why Lua, not application code

The rate limiter and circuit breaker are written in **Redis Lua scripts**, not TypeScript.

This is the single most consequential implementation choice in the backend. N workers ×
M concurrent jobs all checking "have we hit 200 this hour?" is a read-modify-write race.
Every worker reads 199, every worker concludes it has room, and the limit is breached.

Redis executes a Lua script atomically — nothing interleaves between the read and the
write. That makes the limit correct for any number of processes or machines, which is
exactly what the brief means by "safe across multiple workers / instances". No amount of
careful JavaScript achieves this; the race is in the protocol, not the language.

---

## Frontend

| Package | Why |
|---|---|
| **React 19** | Required by the brief ("React.js or Next.js"). `useDeferredValue` is used to keep the compose form responsive while the Delivery Planner recomputes. |
| **Vite 6.4** | Fast dev server, simple config. Pinned at the root so exactly one copy is hoisted ([devlog §3](./06-DEVLOG.md)). |
| **Tailwind CSS 4** | Required by the brief. v4's CSS-first `@theme` block means the design tokens live in one CSS file, including the validated chart palette. |
| **TanStack Query 5** | Caching, deduplication, background refetch and polling. Replaces a large amount of hand-written `useEffect` + loading-state code, and gives the loading/empty/error states the brief asks for almost for free. |
| **React Router 7** | Routing and the auth guard. |
| **Recharts 3.1** | The Delivery Planner bar chart. Chosen over hand-rolled SVG for the responsive container and tooltip layer; over Chart.js because it composes as React components rather than imperatively mutating a canvas. |
| **clsx + tailwind-merge** | `cn()`. `twMerge` matters: without it `px-2 px-4` leaves both classes present and which wins depends on CSS source order, so a component's `className` prop would only sometimes override its defaults. |

### Why React + Vite rather than Next.js

Both are permitted by the brief. Vite was chosen because **Express owns authentication
end to end**.

With Next.js the natural path is NextAuth, which gives a second session system that must
then be bridged to the Express API's own — and that bridge is the most common place these
submissions leak authorisation. One auth authority means one place to get tenant scoping
right, and it is what makes the "every endpoint is guarded" test meaningful.

A dashboard SPA also gains little from SSR.

---

## Infrastructure

| Service | Version | Notes |
|---|---|---|
| **PostgreSQL** | 16-alpine | Source of truth. `--locale=C` for deterministic `ORDER BY` across machines. |
| **Redis** | 7-alpine | **`--appendonly yes` is mandatory.** Default RDB snapshotting can lose the last seconds of writes on a hard kill, and delayed jobs *are* the schedule. Also `--maxmemory-policy noeviction`, so job data is never evicted to satisfy a memory cap. |
| **Elasticsearch** | 8.15 | Single node, security disabled **for local dev only**. `0` replicas so the cluster reports GREEN rather than sitting permanently YELLOW and making the health check misleading. |

---

## Testing

| Package | Why |
|---|---|
| **Vitest 3.2** | Shares Vite's transform pipeline, so no separate Babel/ts-jest config. v3 specifically — v2 depends on Vite 5 and caused the duplicate-install problem in [devlog §3](./06-DEVLOG.md). |

**32 tests**: 25 planner (including the brief's own 1,000-lead / 7-window example as an
executable assertion) and 7 route-security.

The route-security suite walks the **real Express router stack** rather than a list of
routes, and was verified to actually fail when an unguarded route is introduced — the
first version of it did not ([devlog §1](./06-DEVLOG.md)).

---

## Deliberately not used

| Not used | Why not |
|---|---|
| `node-cron`, `agenda`, `bree` | **Forbidden by the brief.** Recurring work is a self-chaining delayed job. |
| BullMQ's `repeat:` option | Cron-expression backed, so it falls under the same prohibition even though it is a BullMQ feature. |
| Handlebars / EJS for merge fields | Would execute code from a user-supplied campaign body — server-side template injection for a feature that needs only `{{key}}` string replacement. |
| Redux / Zustand | TanStack Query covers server state; the little genuinely-local state is `useState`. A global store would be ceremony. |
| bcrypt/argon2 for refresh tokens | The input is already 256 bits of crypto-random, so there is no low-entropy secret to brute-force. A slow KDF would add latency to every refresh for zero gain. Plain SHA-256 is correct *here specifically* — user passwords would be different, but there are none (Google OAuth only). |
| A component library (MUI, Chakra) | The brief explicitly asks for reusable components as a code-quality signal. Importing them would skip the thing being assessed. |
