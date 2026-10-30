import { releaseDigest } from '@rezics/definitions';
import { bundledRelease, bundledSources } from '@rezics/definitions/bundled';
import { compileCatalogue } from '@rezics/definitions/compile';
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import type { HttpResponse, Persona, Release, SemanticDriver } from '../../../../specs/semantic-driver.ts';
import { createAuthBindings } from '../../src/access/auth-bindings.ts';
import { createAccess } from '../../src/access/index.ts';
import { createRegistrationProofBindings } from '../../src/access/registration-proof.ts';
import { createRegistrationPorts } from '../support/registration-ports.ts';
import { createSuspensionCommands } from '../../src/access/suspension.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createPool } from '../../src/database/pool.ts';
import { startRelays } from '../../src/events/relays.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { dropTestDatabase } from '../support/drop-test-database.ts';
import { actionCatalogue } from '../../src/http/request.ts';
import { setupPresentation } from '../../src/presentation/setup.ts';
import { routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import { setupSemantic } from '../../src/semantic/setup.ts';
import { setupContent } from '../../src/content/setup.ts';
import { sharedAuth, type OwnedResourceObserver } from './outcome-auth.ts';

type Account = { accountId: string; bearer: string };
export const releasedDiscoveryFeatures = Object.freeze(['personal_library', 'reading_progress'] as const);
export type ReleasedDiscoveryFeature = (typeof releasedDiscoveryFeatures)[number];

const password = 'semantic outcome registration password with enough entropy';
const clientId = 'semantic-outcomes';
const kernelRoot = resolve(import.meta.dir, '../..');

function required<T>(value: T | null | undefined, message: string): T {
  if (value == null) throw new Error(message);
  return value;
}

function databaseUrl(source: URL, name: string): string {
  const value = new URL(source);
  value.pathname = `/${name}`;
  return value.href;
}

async function assertDatabaseNameAvailable(owner: Pool, name: string): Promise<void> {
  const result = await owner.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
  if (result.rowCount) throw new Error(`Semantic outcome database name is already in use: ${name}`);
}

async function jsonResponse(response: Response): Promise<HttpResponse> {
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

type Tracked = { settled: Promise<void>; close(): Promise<void> };
/** Every driver whose setup has begun and that nobody has closed yet. */
const tracked = new Set<Tracked>();
let started = 0;

/** With SEMANTIC_DRIVER_TIMINGS naming a file, each driver appends one line of per-phase wall time. */
function phaseTimer() {
  const phases = new Map<string, number>();
  let last = performance.now();
  return {
    mark(name: string) {
      const now = performance.now();
      phases.set(name, (phases.get(name) ?? 0) + now - last);
      last = now;
    },
    report(number: number) {
      const file = process.env.SEMANTIC_DRIVER_TIMINGS;
      if (!file) return;
      const line = [...phases].map(([name, ms]) => `${name} ${Math.round(ms)}ms`).join(', ');
      appendFileSync(file, `driver ${number}: ${line}, load ${loadavg()[0]!.toFixed(1)}\n`);
    },
    closed(number: number) {
      const file = process.env.SEMANTIC_DRIVER_TIMINGS;
      if (file) appendFileSync(file, `driver ${number}: closed in ${Math.round(performance.now() - last)}ms\n`);
    },
  };
}

export type SemanticOutcomeDriver = SemanticDriver & {
  readonly fixtures: {
    pool: Pool;
    runtime: {
      databaseUrl: string;
      routeKey: string;
      sessionKeys: string;
      authIssuer: string;
      authAudience: string;
      authJwksUrl: string;
    };
    person(name: string, options?: { scopes?: readonly string[] }): Promise<Account>;
    scopeVariant(account: Account, scopes: readonly string[]): Promise<Account>;
    openFeatures(groups: readonly ReleasedDiscoveryFeature[]): Promise<void>;
    grantAccount(account: Account, actions: string[], resourceId?: string): Promise<void>;
    send(
      account: Account | null,
      method: 'GET' | 'POST' | 'PUT' | 'DELETE',
      path: string,
      body?: unknown,
      headers?: Record<string, string>,
    ): Promise<HttpResponse>;
  };
};

export type SemanticOutcomeOptions = {
  /** Named development gate grants for the original fourteen semantic capability scenarios only. */
  originalCapabilities?: boolean;
  linkProjection?: 'owned' | 'external';
  beforeClose?: () => Promise<void>;
  onOwnedResource?: OwnedResourceObserver;
  strictCleanup?: boolean;
};

/** A caller can abandon a pending call (a hook that timed out), so the next call first lets that setup finish,
 * then closes it. Otherwise its host and database outlive the caller and the next setup collides with them. */
export function createSemanticDriver(
  compose: typeof createKernel = createKernel,
  options: SemanticOutcomeOptions = {},
): Promise<SemanticOutcomeDriver> {
  const earlier = [...tracked];
  const entry: Tracked = { settled: Promise.resolve(), close: async () => {} };
  const starting = (async () => {
    await Promise.all(earlier.map((previous) => previous.settled));
    for (const previous of earlier) {
      await previous.close();
      tracked.delete(previous);
    }
    return startDriver(entry, compose, options);
  })();
  entry.settled = starting.then(
    () => {},
    () => {},
  );
  tracked.add(entry);
  return starting;
}

async function startDriver(
  entry: Tracked,
  compose: typeof createKernel,
  options: SemanticOutcomeOptions,
): Promise<SemanticOutcomeDriver> {
  const timer = phaseTimer();
  const number = ++started;
  let source: URL | undefined;
  let kernelName: string | undefined;
  let owner: Pool | undefined;
  const owned: string[] = [];
  let pool: Pool | undefined;
  let release: (() => void) | undefined;
  let relays: ReturnType<typeof startRelays> | undefined;
  let completion: Promise<void> | undefined;
  const close = () => {
    if (completion) return completion;
    completion = (async () => {
      timer.mark('rest');
      const errors: unknown[] = [];
      const attempt = async (step: () => unknown | Promise<unknown>) => {
        try {
          await step();
        } catch (error) {
          errors.push(error);
        }
      };
      await attempt(async () => options.beforeClose?.());
      await attempt(() => release?.());
      await attempt(async () => relays?.stop());
      await attempt(async () => pool?.end());
      if (owner) {
        for (const name of owned.reverse()) await attempt(() => dropTestDatabase(owner!, name));
        await attempt(() => owner!.end());
      }
      timer.closed(number);
      tracked.delete(entry);
      if (options.strictCleanup && errors.length)
        throw new AggregateError(errors, 'Semantic outcome fixture cleanup failed');
    })();
    return completion;
  };
  entry.close = close;

  try {
    source = new URL(required(process.env.DATABASE_URL, 'DATABASE_URL must name the migrated test database'));
    const template = decodeURIComponent(source.pathname.slice(1));
    if (!/^[A-Za-z0-9_]+$/.test(template)) throw new Error('Unsafe template database name');

    const suffix = randomUUID().replaceAll('-', '');
    kernelName = `semantic_${suffix}`;
    owner = new Pool({ connectionString: databaseUrl(source, 'postgres'), max: 1 });
    await assertDatabaseNameAvailable(owner, kernelName);
    await options.onOwnedResource?.({ kind: 'kernel_database', name: kernelName });
    owned.push(kernelName);
    await owner.query(`CREATE DATABASE "${kernelName}" TEMPLATE "${template}"`);
    const kernelUrl = databaseUrl(source, kernelName);
    pool = createPool(kernelUrl);
    timer.mark('kernel database');

    const auth = await sharedAuth(source, options.onOwnedResource, options.strictCleanup ?? false);
    const { issuer, audience, service, host, database: authPool } = auth;

    const routeKey = randomBytes(32);
    const sessionKeys = { current: 1, keys: new Map([[1, randomBytes(32)]]) };
    const authJwksUrl = `${issuer}/.well-known/jwks.json`;
    let runtimeAuth: { issuer: string; audience: string; jwksUrl: string } | undefined;
    let access!: ReturnType<typeof createAccess>;
    const app = compose({
      pool,
      routeKey,
      tokens: sessionKeys,
      writeRate: createWriteRateLimiter({
        secret: 'semantic-outcome-write-rate-secret-with-at-least-32-bytes',
      }),
      access(config) {
        access = createAccess({
          ...config,
          auth: {
            issuer,
            audience,
            jwksUrl: authJwksUrl,
            ...(new URL(issuer).hostname === 'auth.native.rezics.com'
              ? {
                  // Auth's actual in-process public JWKS handler serves this browser-visible
                  // native issuer while the kernel verifies the advertised issuer claim.
                  fetch: (url: string | URL, init?: RequestInit) => service.handler(new Request(url, init)),
                }
              : {}),
          },
        });
        runtimeAuth = { issuer, audience, jwksUrl: authJwksUrl };
        return access;
      },
    });

    const scopes = [...actionCatalogue(app).keys()].filter((scope) => scope !== 'media:complete');
    const governanceScopes = [...scopes, 'gate:any'];
    const knownScopes = new Set(governanceScopes);
    const registration = createRegistrationProofBindings({ pool, referenceKeys: sessionKeys });
    const { ports: registrationPorts } = createRegistrationPorts({
      pool,
      authPool,
      routeKey,
      referenceKeys: sessionKeys,
    });
    release = auth.bind({
      trustedAccess: createAuthBindings({
        pool,
        ...registration,
        verifyPendingIdentity: registration.verifyNativePendingIdentity,
      }),
      access: registrationPorts,
    });
    await auth.registerClient(clientId, governanceScopes);
    timer.mark('auth side');

    async function issue(email: string, scopes: readonly string[]): Promise<string> {
      const signed = await service.handler(
        new Request(`${issuer}/signin`, {
          method: 'POST',
          headers: { origin: issuer, 'content-type': 'application/json' },
          body: JSON.stringify({ email, password, client_id: clientId, scope: scopes }),
        }),
      );
      if (signed.status !== 200) throw new Error(`Semantic fixture sign-in failed: ${signed.status}`);
      const cookie = signed.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
      const issued = await service.handler(
        new Request(`${issuer}/token`, {
          method: 'POST',
          headers: { origin: issuer, 'content-type': 'application/json', cookie },
          body: '{}',
        }),
      );
      if (issued.status !== 200) throw new Error(`Semantic fixture token issuance failed: ${issued.status}`);
      return ((await issued.json()) as { access_token: string }).access_token;
    }

    const credentials = new WeakMap<Account, { email: string; scopes: readonly string[] }>();
    const people = new Map<string, { scopes: string; account: Promise<Account> }>();
    async function person(name: string, options?: { scopes?: readonly string[] }): Promise<Account> {
      const requested = options?.scopes === undefined ? scopes : options.scopes;
      if (!Array.isArray(requested)) throw new Error('Semantic fixture scopes must be an array');
      for (const scope of requested) {
        if (typeof scope !== 'string' || !knownScopes.has(scope))
          throw new Error(`Unknown semantic fixture scope: ${String(scope)}`);
      }
      const chosen = [...new Set(requested)].sort();
      const canonical = JSON.stringify(chosen);
      const existing = people.get(name);
      if (existing) {
        if (existing.scopes !== canonical)
          throw new Error(`Semantic fixture person ${name} is already bound to a different scope set`);
        return existing.account;
      }

      // Reserve the name before native registration starts, including while issuance is still pending.
      const account = Promise.resolve().then(async () => {
        const email = `${name}-${suffix}@semantic.test`;
        const result = await host.workflows.register({
          key: `${name}-${suffix}`,
          handle: `${name}_${suffix}`,
          email,
          password,
        });
        const account = { accountId: result.accountId, bearer: await issue(email, chosen) };
        credentials.set(account, { email, scopes: chosen });
        return account;
      });
      people.set(name, { scopes: canonical, account });
      return account;
    }

    async function scopeVariant(account: Account, requested: readonly string[]): Promise<Account> {
      if (completion) throw new Error('Semantic outcome fixture is closed');
      const original = credentials.get(account);
      if (!original) throw new Error('Scope variants require an existing native fixture account');
      if (!Array.isArray(requested)) throw new Error('Semantic fixture scopes must be an array');
      for (const scope of requested) {
        if (!knownScopes.has(scope) || !original.scopes.includes(scope))
          throw new Error(`Scope variant must be a known subset of the original scopes: ${String(scope)}`);
      }
      const chosen = [...new Set(requested)].sort();
      const bearer = await issue(original.email, chosen);
      const actor = await access.authenticate(bearer, { pool: pool!, deadline: Date.now() + 10_000 });
      if (
        actor.kind !== 'account' ||
        actor.accountId !== account.accountId ||
        JSON.stringify([...actor.scopes].sort()) !== JSON.stringify(chosen)
      )
        throw new Error('Native scope variant changed account identity or requested scopes');
      const variant = { accountId: actor.accountId, bearer };
      credentials.set(variant, { email: original.email, scopes: chosen });
      return variant;
    }

    const [governor, editor, acceptor, steward, suspended] = await Promise.all([
      person('governor', { scopes: governanceScopes }),
      person('editor'),
      person('acceptor'),
      person('steward'),
      person('suspended'),
    ]);
    const accounts = { editor, acceptor, steward, suspended } satisfies Record<Exclude<Persona, 'anonymous'>, Account>;

    await setupSemantic(pool, bundledRelease);
    await setupContent(pool);
    await setupPresentation(pool);

    const bootstrap = Bun.spawn(
      [process.execPath, 'scripts/bootstrap-governance.ts', '--account', governor.accountId],
      {
        cwd: kernelRoot,
        env: { ...process.env, DATABASE_URL: kernelUrl },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [bootstrapCode, bootstrapOut, bootstrapErr] = await Promise.all([
      bootstrap.exited,
      new Response(bootstrap.stdout).text(),
      new Response(bootstrap.stderr).text(),
    ]);
    if (bootstrapCode !== 0)
      throw new Error(`Governance bootstrap exited ${bootstrapCode}: ${bootstrapOut}${bootstrapErr}`);

    const sessions = new Map<Exclude<Persona, 'anonymous'>, string>();
    async function send(
      account: Account | null,
      method: 'GET' | 'POST' | 'PUT' | 'DELETE',
      path: string,
      body?: unknown,
      headers?: Record<string, string>,
      persona?: Exclude<Persona, 'anonymous'>,
    ): Promise<HttpResponse> {
      const requestHeaders = new Headers(headers);
      if (account) requestHeaders.set('authorization', `Bearer ${account.bearer}`);
      if (persona && sessions.has(persona)) requestHeaders.set('rezics-session-token', sessions.get(persona)!);
      if (body !== undefined) requestHeaders.set('content-type', 'application/json');
      const response = await app.handle(
        new Request(`http://kernel.test${path}`, {
          method,
          headers: requestHeaders,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
      const session = response.headers.get('rezics-session-token');
      if (persona && session) sessions.set(persona, session);
      return jsonResponse(response);
    }

    const key = () => `"${randomUUID()}"`;
    const collectionExposure = await send(governor, 'POST', '/v1/platform/exposure/collections:open', undefined, {
      'Idempotency-Key': key(),
    });
    if (collectionExposure.status !== 200)
      throw new Error(
        `Collection exposure setup failed: ${collectionExposure.status}: ${JSON.stringify(collectionExposure.body)}`,
      );

    async function grantAccount(
      account: Account,
      actions: string[],
      resourceId = GLOBAL_CONTEXT,
      grantor: Account = governor,
    ) {
      const route = resourceId === GLOBAL_CONTEXT ? 0 : routeOf(resourceId);
      if (route === null) throw new Error(`Cannot grant an unroutable resource: ${resourceId}`);
      const response = await send(
        grantor,
        'POST',
        '/v1/grants',
        {
          resource: { route, id: resourceId },
          subject: { kind: 'account', id: account.accountId },
          actions,
          valid: '(,)',
        },
        { 'Idempotency-Key': key() },
      );
      if (response.status !== 201)
        throw new Error(`Grant administration failed: ${response.status}: ${JSON.stringify(response.body)}`);
    }

    await grantAccount(accounts.editor, ['subject:create', 'statement:propose', 'context:create']);
    await grantAccount(accounts.acceptor, ['context:accept', 'context:adopt', 'subject:merge']);
    await grantAccount(accounts.steward, ['definitions:publish', 'definitions:activate']);
    if (options.originalCapabilities) {
      await grantAccount(accounts.steward, ['gate:definition_publication']);
      await grantAccount(accounts.acceptor, ['gate:subject_identity']);
      await grantAccount(accounts.editor, ['gate:definition_publication', 'gate:subject_identity']);
    }
    await grantAccount(accounts.suspended, [
      'subject:create',
      'statement:propose',
      'context:create',
      'context:accept',
      'context:adopt',
      'subject:merge',
    ]);

    const boundary = { pool, deadline: Date.now() + 10_000 };
    await createSuspensionCommands({ pool, access, clock: () => new Date() }).suspend(
      { ...boundary, actor: await access.authenticate(governor.bearer, boundary) },
      { accountId: accounts.suspended.accountId, key: randomUUID() },
    );

    if ((options.linkProjection ?? 'owned') === 'owned')
      relays = startRelays(pool, [linkProjection(pool)], { intervalMs: 25 });

    const driver: SemanticDriver = {
      globalContext: GLOBAL_CONTEXT,
      request(persona, method, path, body, headers) {
        if (persona === 'anonymous') return send(null, method, path, body, headers);
        return send(accounts[persona], method, path, body, headers, persona);
      },
      async compile(root, schemas, presentation) {
        const bundled = bundledSources();
        const mergedPresentation = { ...bundled.presentation };
        for (const [language, additions] of Object.entries(presentation)) {
          const base = Bun.YAML.parse(mergedPresentation[language] ?? '{}') as {
            types?: Record<string, string>;
            properties?: Record<string, string>;
          };
          mergedPresentation[language] = Bun.YAML.stringify({
            types: { ...(base.types ?? {}), ...(additions.types ?? {}) },
            properties: { ...(base.properties ?? {}), ...(additions.properties ?? {}) },
          });
        }
        const release = await compileCatalogue({
          root,
          schemas: { ...bundled.schemas, ...schemas },
          presentation: mergedPresentation,
          contexts: bundled.contexts,
          filters: bundled.filters,
        });
        return { digest: releaseDigest(release), release: release as unknown as Release };
      },
      async grant(persona, actions, resourceId) {
        if (persona === 'anonymous') throw new Error('Anonymous is not an account grant recipient');
        const grantor = resourceId === GLOBAL_CONTEXT ? governor : editor;
        await grantAccount(accounts[persona], actions, resourceId, grantor);
      },
      async projection(state) {
        if ((options.linkProjection ?? 'owned') === 'external')
          throw new Error('Semantic helper projection control is unavailable when link projection is external');
        if (state === 'paused') await relays!.pause();
        else relays!.resume();
      },
      inspect: {
        async revisions(subjectId) {
          const route = routeOf(subjectId);
          if (route === null) return [];
          const rows = await pool!.query<{
            revision: number;
            partition: number;
            transaction_id: string;
          }>(
            `SELECT revision, route >> 4 AS partition,
                    recorded_transaction_id::text AS transaction_id
               FROM semantic.revision
              WHERE route=$1 AND subject_id=$2
              ORDER BY revision`,
            [route, subjectId],
          );
          return rows.rows.map((row) => ({
            revision: Number(row.revision),
            partition: Number(row.partition),
            transactionId: row.transaction_id,
          }));
        },
      },
      close: () => entry.close(),
    };
    timer.mark('rest');
    timer.report(number);
    return {
      ...driver,
      fixtures: {
        pool: pool!,
        runtime: {
          databaseUrl: kernelUrl,
          routeKey: Buffer.from(routeKey).toString('base64url'),
          sessionKeys: [...sessionKeys.keys]
            .map(([id, key]) => `${id}:${Buffer.from(key).toString('base64url')}`)
            .join(','),
          authIssuer: required(runtimeAuth?.issuer, 'Kernel did not construct Access with the Auth issuer'),
          authAudience: required(runtimeAuth?.audience, 'Kernel did not construct Access with the Auth audience'),
          authJwksUrl: required(runtimeAuth?.jwksUrl, 'Kernel did not construct Access with the Auth JWKS URL'),
        },
        person,
        scopeVariant,
        async openFeatures(groups) {
          if (completion) throw new Error('Semantic outcome fixture is closed');
          if (!Array.isArray(groups) || groups.some((group) => !releasedDiscoveryFeatures.includes(group)))
            throw new Error('Released discovery features must be personal_library or reading_progress');
          for (const group of new Set(groups)) {
            const response = await send(governor, 'POST', `/v1/platform/exposure/${group}:open`, undefined, {
              'Idempotency-Key': key(),
            });
            // Preserve the native status, problem and headers for missing policy/runtime prerequisites.
            if (response.status !== 200) throw response;
          }
        },
        grantAccount: (account, actions, resourceId) => grantAccount(account, actions, resourceId),
        send: (account, method, path, body, headers) => send(account, method, path, body, headers),
      },
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      if (options.strictCleanup)
        throw new AggregateError([error, cleanupError], 'Semantic outcome setup and cleanup failed', { cause: error });
    }
    throw error;
  }
}
