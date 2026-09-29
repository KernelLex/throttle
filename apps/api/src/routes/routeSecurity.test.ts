/**
 * Route security guard test.
 *
 * WHY THIS TEST EXISTS
 * --------------------
 * "All endpoints are protected" is a claim that decays. Someone adds a route in six
 * months, forgets the guard, and nothing complains — the endpoint works perfectly,
 * which is exactly the problem. Code review catches this only if the reviewer happens
 * to be thinking about it that day.
 *
 * This test walks the REAL Express router stack and asserts that every registered
 * route is either guarded by `requireAuth` or listed in the explicit PUBLIC_PATHS
 * allowlist. An unprotected new route fails CI, and the only way to make it pass is
 * to deliberately add it to the allowlist — a visible, reviewable diff rather than a
 * silent omission.
 *
 * HOW GUARD DETECTION WORKS
 * -------------------------
 * Guards are detected by walking the actual middleware stacks, NOT by a hardcoded
 * list of protected prefixes. Two ways a route can be guarded:
 *
 *   1. per-route:   router.get('/x', requireAuth, handler)
 *   2. router-wide: router.use(requireAuth)  ← how most routers here do it
 *
 * Case 2 is why this walker tracks inherited guards as it recurses. A hardcoded
 * prefix list would be a second copy of the truth, and would happily pass if someone
 * removed a `router.use(requireAuth)` line without touching the test.
 */

import { describe, expect, it } from 'vitest';

// app.ts imports config.ts, which validates the environment at import time and calls
// process.exit(1) on failure. Provide a valid set first so this test does not depend
// on any particular developer's local .env.
process.env['NODE_ENV'] = 'test';
process.env['API_BASE_URL'] ??= 'http://localhost:4000';
process.env['WEB_BASE_URL'] ??= 'http://localhost:5173';
process.env['DATABASE_URL'] ??= 'postgresql://throttle:throttle@localhost:5432/throttle_test';
process.env['REDIS_URL'] ??= 'redis://localhost:6379';
process.env['ELASTICSEARCH_URL'] ??= 'http://localhost:9200';
process.env['JWT_ACCESS_SECRET'] ??= 'a'.repeat(48);
process.env['JWT_REFRESH_SECRET'] ??= 'b'.repeat(48);
process.env['COOKIE_SECRET'] ??= 'c'.repeat(32);
process.env['ENCRYPTION_KEY'] ??= '0'.repeat(64);

const { createApp } = await import('../app.js');
const { PUBLIC_PATHS } = await import('../middleware/auth.js');

const AUTH_GUARD_NAME = 'requireAuth';
const ROLE_GUARD_NAME = 'requireRoleGuard';

interface DiscoveredRoute {
  method: string;
  path: string;
  /** Guards on the route itself plus any inherited from enclosing routers. */
  guards: string[];
  guarded: boolean;
  adminOnly: boolean;
}

/**
 * A guard applied via `.use()`, together with the path prefix it actually covers.
 *
 * The prefix is essential. `app.use('/admin/queues', requireAuth, ...)` places a
 * layer named `requireAuth` in the APP-level stack — and an earlier version of this
 * test treated that as covering every route in the application, which made the whole
 * file pass vacuously. A deliberately unguarded `POST /api/secret-leak` sailed
 * straight through it.
 *
 * Guards are therefore matched by prefix: a route is only covered by a guard mounted
 * at or above its own path.
 */
interface MountedGuard {
  name: string;
  prefix: string;
}

/** Express layer internals — not described by @types/express. */
interface ExpressLayer {
  name?: string;
  regexp?: RegExp;
  handle?: { stack?: ExpressLayer[] };
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: { name?: string }[];
  };
}

/** Recover a router's mount path from its layer regexp. */
function mountPath(layer: ExpressLayer): string {
  if (!layer.regexp) return '';
  const source = layer.regexp.source;
  if (source === '^\\/?$' || source === '^\\/?(?=\\/|$)') return '';

  const match = /^\^\\\/((?:[\w\-\\/]|\\\/)*?)\\\/\?/.exec(source);
  if (!match?.[1]) return '';
  return `/${match[1].replace(/\\\//g, '/')}`;
}

const normalisePath = (path: string): string =>
  path.replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1');

/**
 * Walk the router stack, accumulating guards inherited from `.use(...)` as it
 * descends into nested routers — each tagged with the prefix it actually covers.
 */
function discoverRoutes(
  stack: ExpressLayer[],
  prefix = '',
  inheritedGuards: MountedGuard[] = [],
): DiscoveredRoute[] {
  const routes: DiscoveredRoute[] = [];

  // First pass: collect middleware applied via `.use()` at this level.
  // `router.use(requireAuth)` appears as a non-route layer named after the function.
  const activeGuards = [...inheritedGuards];
  for (const layer of stack) {
    if (layer.route || layer.handle?.stack || !layer.name) continue;
    if (layer.name !== AUTH_GUARD_NAME && layer.name !== ROLE_GUARD_NAME) continue;

    // mountPath() is '' for a path-less `.use(fn)`, which then covers this whole
    // router; otherwise it is the sub-path the guard was mounted at.
    activeGuards.push({
      name: layer.name,
      prefix: normalisePath(prefix + mountPath(layer)),
    });
  }

  for (const layer of stack) {
    if (layer.route) {
      const path = normalisePath(`${prefix}${layer.route.path}`);

      const inherited = activeGuards
        .filter((guard) => path === guard.prefix || path.startsWith(`${guard.prefix}/`))
        .map((guard) => guard.name);

      const own = layer.route.stack.map((entry) => entry.name ?? '').filter(Boolean);
      const guards = [...inherited, ...own];

      const methods = Object.keys(layer.route.methods)
        .filter((method) => layer.route!.methods[method])
        .map((method) => method.toUpperCase());

      for (const method of methods) {
        routes.push({
          method,
          path,
          guards,
          guarded: guards.includes(AUTH_GUARD_NAME),
          adminOnly: guards.includes(ROLE_GUARD_NAME),
        });
      }
      continue;
    }

    if (layer.name === 'router' && layer.handle?.stack) {
      routes.push(
        ...discoverRoutes(layer.handle.stack, prefix + mountPath(layer), activeGuards),
      );
    }
  }

  return routes;
}

const app = createApp();
const appStack = (app as unknown as { _router: { stack: ExpressLayer[] } })._router.stack;
const routes = discoverRoutes(appStack);

const format = (list: DiscoveredRoute[]): string =>
  list.map((r) => `  ${r.method.padEnd(6)} ${r.path}  [${r.guards.join(', ') || 'NO GUARDS'}]`).join('\n');

describe('route security', () => {
  it('discovers the application routes', () => {
    // Guards the walker itself. If discovery silently returned nothing, every
    // assertion below would pass vacuously and this file would be worthless.
    expect(routes.length).toBeGreaterThan(20);
  });

  it('protects every route that is not on the public allowlist', () => {
    const unprotected = routes.filter((r) => !r.guarded && !PUBLIC_PATHS.includes(r.path));

    expect(
      unprotected,
      `These routes have no authentication guard. Either mount requireAuth, or add ` +
        `the path to PUBLIC_PATHS in middleware/auth.ts with a written justification:\n` +
        format(unprotected),
    ).toEqual([]);
  });

  it('exposes no unauthenticated write endpoint', () => {
    const writeMethods = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

    // The only permitted exceptions: refresh authenticates via the refresh cookie,
    // and logout must work even with an expired access token. Requiring a valid
    // session for either would be circular.
    const allowed = new Set(['/api/auth/refresh', '/api/auth/logout']);

    const publicWrites = routes.filter(
      (r) => writeMethods.has(r.method) && !r.guarded && !allowed.has(r.path),
    );

    expect(
      publicWrites,
      `Unauthenticated write endpoints found:\n${format(publicWrites)}`,
    ).toEqual([]);
  });

  it('requires ADMIN for sender credential management', () => {
    // Senders hold SMTP credentials; creating or editing one must not be available
    // to an ordinary member.
    const senderWrites = routes.filter(
      (r) => r.path.startsWith('/api/senders') && r.method !== 'GET',
    );

    expect(senderWrites.length).toBeGreaterThan(0);
    for (const route of senderWrites) {
      expect(route.adminOnly, `${route.method} ${route.path} is not ADMIN-gated`).toBe(true);
    }
  });

  it('keeps the public allowlist small and intentional', () => {
    // A guard against the allowlist quietly becoming the path of least resistance.
    expect(PUBLIC_PATHS.length).toBeLessThanOrEqual(10);
  });

  it('every public path corresponds to a real route', () => {
    // Catches stale allowlist entries: a path left behind after a route is renamed
    // is dead config that looks like an intentional exemption.
    const known = new Set(routes.map((r) => r.path));
    const stale = PUBLIC_PATHS.filter((p) => !known.has(p));

    expect(stale, `PUBLIC_PATHS entries with no matching route: ${stale.join(', ')}`).toEqual([]);
  });
});

describe('Bull Board exposure', () => {
  it('defaults to requiring ADMIN when the flag is unset', async () => {
    // The flag must FAIL CLOSED. If BULL_BOARD_REQUIRE_ADMIN is absent, the queue
    // dashboard — which exposes recipient addresses and allows retrying and deleting
    // jobs — must still demand an administrator.
    delete process.env['BULL_BOARD_REQUIRE_ADMIN'];
    const { env } = await import('../config.js');
    expect(env.BULL_BOARD_REQUIRE_ADMIN).toBe(true);
  });
});
