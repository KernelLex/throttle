# Security

Threat model and posture, endpoint by endpoint.

The brief asks that APIs and endpoints not be public. That is treated here as a property
to be **enforced and tested**, not asserted — see [§1](#1-no-endpoint-is-public).

---

## 1. No endpoint is public

Every route requires a session except six, each individually justified:

| Path | Why it is public | What protects it instead |
|---|---|---|
| `/healthz` | Liveness probe | Exposes only uptime and role |
| `/readyz` | Readiness probe | Exposes only up/down per dependency |
| `/api/config` | Tells the frontend which login providers exist | Booleans only, no secrets |
| `/api/auth/google` | Starts login — nobody is signed in yet | Single-use `state` in Redis |
| `/api/auth/google/callback` | Google redirects here pre-session | Single-use `state` + PKCE verifier |
| `/api/auth/refresh` | Authenticates via the **refresh** cookie, not the access one | Hashed token + reuse detection |
| `/api/auth/logout` | Must work with an expired access token | Idempotent, no data returned |
| `/api/slack/callback` | Slack redirects here | Single-use `state` binding tenant + user |

### This is enforced by a test

[`routeSecurity.test.ts`](../apps/api/src/routes/routeSecurity.test.ts) walks the **real
Express router stack** and fails if any route is neither guarded nor on the allowlist.

It asserts:
1. Every route is guarded or explicitly allowlisted
2. No unauthenticated write endpoint exists (bar refresh/logout)
3. Sender credential management is ADMIN-gated
4. The allowlist stays ≤ 10 entries
5. No allowlist entry is stale (a path left behind after a rename)
6. Bull Board's admin flag **defaults to true when unset**

> **The test was verified to actually fail.** An unguarded `POST /api/secret-leak` was
> injected and the suite was confirmed to catch it. The first version of this test passed
> vacuously — [devlog §1](./06-DEVLOG.md) has the full story. A security test that has
> never been seen to fail is worse than no test, because it manufactures confidence.

### Bull Board

The queue dashboard exposes recipient email addresses, tenant ids and job payloads, and
allows retrying and deleting jobs. It is the endpoint most often left wide open.

```ts
const bullBoardGuards = env.BULL_BOARD_REQUIRE_ADMIN
  ? [requireAuth, requireRole('ADMIN')]
  : [requireAuth];
```

`BULL_BOARD_REQUIRE_ADMIN` **fails closed** — unset or empty resolves to `true`. An
unset security flag must never mean "off".

---

## 2. Authentication

### Google OAuth — authorization code + PKCE, backend-owned

The implicit flow is deprecated, and any flow putting a client secret in frontend code
has no secret. The exchange happens server-side, over a channel the browser never sees,
and the resulting session lands in an `httpOnly` cookie that JavaScript — ours or an
injected script's — cannot read.

**PKCE is used even though we are a confidential client.** It is strictly required only
for public clients, but it closes authorization-code interception: even if the `code`
leaks (browser history, a proxy log, a bad referrer policy) it is useless without the
`code_verifier`, which never leaves the server.

**`state` is single-use**, stored in Redis with a 10-minute TTL and consumed with
`GETDEL` so the read and delete are atomic. Two concurrent callbacks with the same state
cannot both succeed. That is what makes it a real CSRF defence rather than a formality.

**Domain restriction is enforced on the token-exchange response**, not on the `hd`
request parameter — the latter is user-controlled and trivially removable.

**Unverified Google emails are rejected.** Someone can create a Google account claiming
an address they do not control.

**Open redirect is closed.** `sanitiseRedirect()` accepts same-origin *paths* only —
rejecting absolute URLs, protocol-relative `//evil.com` (which a naive `startsWith('/')`
check would allow), and backslash variants.

### Sessions

| | Access token | Refresh token |
|---|---|---|
| Type | JWT | Opaque random (256-bit) |
| Lifetime | 15 min | 7 days |
| Storage | `httpOnly` cookie | `httpOnly` cookie, **path-scoped to `/api/auth`** |
| Server-side | Stateless | Stored as SHA-256 hash |
| Revocable | No | **Yes** |

A JWT cannot be revoked without a blocklist that defeats being stateless — so the access
token is kept short-lived and the entire revocation story lives in the refresh token.

The refresh cookie is path-scoped so the long-lived credential is not attached to every
ordinary API request; it travels only where it is used.

`issuer` and `audience` are **verified**, not merely present. Without that, a JWT signed
by any other system sharing the secret would be accepted — and secrets get reused across
services more often than anyone admits. The algorithm is pinned to HS256 so a token
cannot nominate `none`.

Access and refresh secrets **must differ** — enforced at boot. Sharing one lets an access
token be replayed as a refresh token, defeating short access lifetimes entirely.

### Refresh token rotation with reuse detection

Every refresh issues a new token and marks the old one replaced. All tokens descended
from one login share a `familyId`.

If an already-rotated token is presented again, exactly one of two things happened: the
token was stolen and the thief is using it, or it was stolen and the legitimate user is
using it. We cannot tell which — so **the entire family is revoked** and both parties
must re-authenticate. This is the OAuth 2.0 BCP mitigation, and it converts a silent
long-lived compromise into a single forced re-login.

The frontend cooperates: refresh is **single-flight**. Three simultaneous 401s must not
fire three refreshes, because the second and third would present an already-rotated token
and the user would be logged out by their own app.

---

## 3. Authorisation and tenant isolation

Every domain query is scoped by `tenantId` **from the session**, never from the request.

```ts
const row = await prisma.campaign.findFirst({
  where: { id: req.params.id, tenantId },   // ← the isolation boundary
});
```

A campaign id belonging to another tenant returns **404, not 403** — deliberately the
same response as a genuinely missing id, so the endpoint cannot be used to enumerate
which ids exist.

**The search endpoint makes the IDOR impossible by construction.** `searchEmailsSchema`
in `@throttle/core` has no `tenantId` field at all, so a client cannot supply one even by
trying. The filter is injected server-side:

```ts
const filters = [{ term: { tenantId: params.tenantId } }];   // always first
```

**There is deliberately no "optional auth" middleware.** A handler reading
`req.auth?.tenantId` with a sensible fallback will serve every tenant's data the day
someone forgets to mount the guard. Handlers call `getAuth(req)`, which throws if the
guard is absent — failing loudly rather than operating on `undefined`.

**Roles:** the first user in a workspace is `ADMIN`; later joiners are `MEMBER`, so an
existing workspace cannot be taken over by signing up to its domain. Sender credential
management and the queue dashboard require `ADMIN`.

---

## 4. Secrets at rest

| Secret | Treatment | Why |
|---|---|---|
| SMTP passwords | **AES-256-GCM** | A leak lets an attacker send mail *as* the customer |
| Slack webhook URL | **AES-256-GCM** | Possession of the URL alone permits posting to the channel — it is a credential, not an address |
| Slack bot token | **AES-256-GCM** | Full workspace API access within scopes |
| Refresh tokens | **SHA-256 hash** | Only ever compared, never recovered |

The distinction is deliberate: anything we do not need to read back is **hashed**, which
is strictly safer than encrypting it.

**GCM, not CBC** — authenticated encryption. Tampering with stored ciphertext makes
decryption *throw* rather than silently yielding garbage that then gets used as an SMTP
password.

Ciphertext is versioned (`v1:iv:authTag:ciphertext`) so key rotation or an algorithm
change is possible later without guessing which rows use which scheme.

`ENCRYPTION_KEY` is validated as exactly 64 hex characters **at boot** — a wrong-length
key otherwise fails at first use, mid-send.

---

## 5. Input validation

Every body, query and param passes a Zod schema. `validateBody` **replaces** `req.body`
with the parsed result, so Zod's stripping of unknown keys means a handler cannot read an
attacker-supplied field that was never in the schema — mass-assignment prevention by
construction rather than by discipline.

### File upload hardening

The lead-upload endpoint takes untrusted files:

- **`memoryStorage`** — nothing user-supplied is written to disk, removing path traversal
  and leftover-temp-file concerns entirely
- Hard byte cap (`MAX_UPLOAD_BYTES`, 10 MB), enforced by multer before we see the data
- Exactly one file; the multipart parser's own `fields`/`parts` bounded too
- Extension allowlist (`.csv`, `.txt`, `.tsv`)
- **Content sniff** — the extension is attacker-controlled, so a NUL byte in the first
  kilobyte rejects a binary wearing a `.csv` name
- `latin1` decoding, so a mis-encoded byte becomes a character that fails email validation
  rather than a U+FFFD that could silently corrupt an otherwise-valid address
- Recipient count capped at `MAX_LEADS_PER_CAMPAIGN`

**The client-side parse is UX, never a boundary.** The server re-parses the file and uses
its own result.

---

## 6. CSRF

Sessions are cookies, and browsers attach cookies to cross-site requests automatically.
`SameSite=Lax` blocks the obvious cases but is a single point of failure — relaxed for
top-level navigations, inconsistent in older browsers, and would need weakening to `None`
if the frontend moved to a different site.

So: **double-submit token**. A random value in a non-`httpOnly` cookie, echoed in a
request header, compared with `safeCompare` (constant-time — a fast-exit compare leaks
how many leading characters matched).

The security comes from the same-origin policy: `evil.com` can cause the cookie to be
*sent* but cannot *read* it, so it cannot populate the header. That the token cookie is
JS-readable is intentional and safe — it is not a credential, it only proves the request
came from a page on our origin.

OAuth callbacks are exempt (an external top-level redirect can carry no header) and are
protected by their single-use `state` instead.

**`SameSite=Lax`, not `Strict`** — the Google callback is a top-level cross-site
navigation, and `Strict` would withhold the cookie on it, breaking login in a way that
looks like a random redirect loop.

---

## 7. Transport, headers, CORS

- **Helmet** for security headers. CSP is enabled in production and disabled in
  development, because Bull Board's bundled UI uses inline scripts a strict CSP blocks.
  In production the API serves no HTML of its own.
- **HSTS** in production, one year, `includeSubDomains`.
- **CORS has no wildcard mode.** `origin: true` with `credentials: true` would let any
  site make authenticated requests. Rejected origins are logged.
- **`trust proxy` is `1`, not `true`.** Trusting *all* hops lets a client spoof its own IP
  by sending `X-Forwarded-For` — which would defeat per-IP rate limiting entirely.
- **HTTPS is required in production**, enforced at boot: `API_BASE_URL` must be `https://`
  because session cookies are set `Secure`.

---

## 8. Rate limiting (HTTP)

Redis-backed so the budget is shared across API instances — an in-memory store gives each
instance its own allowance, multiplying the real limit by the instance count.

| Scope | Default |
|---|---|
| `/api/auth/*` | 10 req/min per IP |
| `/api/*` | 300 req/min per IP |

Auth endpoints get a far tighter budget because they are the brute-force target.

---

## 9. Error handling — the disclosure boundary

[`errorHandler.ts`](../apps/api/src/middleware/errorHandler.ts) is the single place an
internal error becomes an HTTP response, and therefore the only place a leak could occur.

Known `AppError`s carry messages written for users and are returned as-is. **Everything
else is replaced** with a generic message plus a request id. A raw exception can contain a
connection string, a SQL fragment, a file path or an upstream provider's verbatim
response.

The request id bridges the gap: the user quotes it, and it correlates exactly with the
full unredacted server log.

Debug detail is attached only when `NODE_ENV !== 'production'`.

**Logging redacts by path** (Pino), so a careless `logger.info({ req })` cannot leak an
`Authorization` header or a `Set-Cookie`.

---

## 10. Fail-fast configuration

`config.ts` validates the entire environment at import time and **exits the process** on
anything invalid.

This matters more than usual for a scheduler. If `MAX_EMAILS_PER_HOUR_PER_SENDER`
silently defaulted to a built-in number because of a typo in `.env`, the system would
keep running and keep sending — at the wrong rate, in a way nobody notices until a
provider starts blocking the domain. A crash at boot is dramatically cheaper.

Production additionally rejects:
- placeholder secrets still reading `change_me…`
- identical access and refresh secrets
- an empty CORS allowlist
- missing Google credentials
- a non-HTTPS `API_BASE_URL`

---

## Known gaps

| Gap | Impact | Mitigation |
|---|---|---|
| Elasticsearch security disabled in local Docker | Local only | Production needs TLS + API keys + network isolation |
| No 2FA | Inherits Google's | Google accounts may enforce their own |
| No per-tenant encryption keys | One key compromise affects all tenants | Versioned ciphertext makes rotation possible |
| Audit log is write-only | No UI to review it | Rows are queryable directly |
| Domain-based tenant auto-join | Anyone with an address at the domain joins the workspace | Public domains get private workspaces; a real product needs invitations |
| Senders authenticate with SMTP passwords | A user hands over a credential with full send access to their mailbox | Encrypted at rest with AES-256-GCM and never returned by the API. A production system would use Google OAuth with the `gmail.send` scope so no password is entered at all |
| No UI to promote a MEMBER to ADMIN | A second user on a shared company domain cannot add a sender | Deliberate: it stops anyone who obtains an address at that domain adding a sending identity. Promotion currently needs a direct database change |
| No E2E security test | Unit-level route guard only | The router-stack test covers the specific failure mode that matters |
