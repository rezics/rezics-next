import { expect } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript-6';
import { registerTelemetryPeers, shutdownTelemetry, startTelemetry, withTelemetrySpan } from '../src/runtime.ts';

// Evaluate the actual harness functions with owner clients injected, without loading or starting QA storage.
function fixtureFunction(path: string, name: string, scope: Record<string, unknown>) {
  const source = readFileSync(resolve(path), 'utf8');
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const fn = parsed.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  if (!fn) throw new Error(`Missing fixture function ${name}`);
  // Later exported helpers are independent fixtures, not part of this function.
  const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(fn.getText(parsed).replace(/^export\s+/, ''));
  return new Function(...Object.keys(scope), `${code}\nreturn ${name};`)(...Object.values(scope));
}

const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init);
  if (new URL(request.url).origin === new URL(process.env.OTEL_EXPORTER_OTLP_ENDPOINT!).origin)
    return originalFetch(input, init);
  return Response.json({ propagated: request.headers.has('traceparent') });
}, originalFetch);
startTelemetry('telemetry-peer-lifetime', { ...process.env,
  FUSEKI_URL: undefined, ACCOUNT_ORIGIN: undefined, ACCOUNT_JWKS_URL: undefined,
  ACCOUNT_INTROSPECT_URL: undefined, MAIN_ORIGIN: undefined, OTEL_PROPAGATION_ORIGINS: '',
});

interface Result {
  scenario: string;
  propagatedBefore?: boolean;
  propagatedAfter: boolean;
  listenerStopped: boolean;
  poolsClosed?: boolean;
  failed: boolean;
}
const results: Result[] = [];
const listeners = new Set<ReturnType<typeof Bun.serve>>();
async function propagated(origin: string) {
  return withTelemetrySpan('lifetime.probe', async () => {
    const response = await fetch(`${origin}/probe`);
    return (await response.json() as { propagated: boolean }).propagated;
  });
}
async function listenerStopped(listener: ReturnType<typeof Bun.serve> | undefined) {
  if (!listener) return true;
  try {
    const response = await originalFetch(listener.url, { signal: AbortSignal.timeout(1000) });
    await response.arrayBuffer();
    return false;
  } catch { return true; }
}
class OwnerStore {}

const mediaStartupFailures = ['migrate', 'matcher', 'objects', 'compose', 'backfill', 'project', 'screen-store'];
const mediaCleanupFailures = ['recovery-stop', 'main-stop', 'pool-close', 'directory-remove'];
try {
  for (const [index, scenario] of [...mediaStartupFailures, ...mediaCleanupFailures, 'registration-invalid', 'normal'].entries()) {
    const origin = `http://127.0.0.1:${42000 + index}`;
    const env = { REZICS_QA_RUN_ID: 'unit-owned-clients', FUSEKI_URL: origin,
      MAIN_DATA_EPOCH: 'epoch', MAIN_ROUTING_EPOCH: 'epoch', ACCESS_DATABASE_URL: 'unused-access',
      CONTENT_DATABASE_URL: 'unused-content', ACCOUNT_RELAY_DATABASE_URL: 'unused-relay',
      MAIN_S3_ENDPOINT: 'http://objects.invalid', MAIN_OBJECT_DIRECTORY: '.temp/unit-owned-objects' };
    const previous = new Map(Object.keys(env).map(key => [key, Bun.env[key]]));
    Object.assign(Bun.env, env);
    const pools: { closed: boolean }[] = [];
    let listener: ReturnType<typeof Bun.serve> | undefined;
    const fail = (step: string) => { if (scenario === step) throw new Error(step); };
    class OwnerPool {
      closed = false;
      constructor() { pools.push(this); }
      async end() { this.closed = true; fail('pool-close'); }
    }
    const startMediaStack = fixtureFunction('tests/qa/integration/media-support.ts', 'startMediaStack', {
      root: process.cwd(), Bun, join, randomUUID,
      mkdirSync: () => {}, rmSync: () => fail('directory-remove'),
      CountingFuseki: OwnerStore, CountingPool: OwnerPool, ContentCore: OwnerStore,
      ContentProjectionCursor: OwnerStore, MediaStore: OwnerStore, CountingMediaAccess: OwnerStore,
      SourceCoverEvidenceVerifier: OwnerStore, SourceIntakeStore: OwnerStore,
      MediaScreenStore: class { constructor() { fail('screen-store'); } },
      attributeDirectoryRefreshQueries: () => {}, connectionBoundOptions: () => '',
      migrateContent: async () => fail('migrate'),
      requiredMatcherMode: () => { fail('matcher'); return 'unit'; }, requiredSafetyMatcher: () => undefined,
      S3ImmutableObjects: class { async initialize() { fail('objects'); } },
      mainConfig: () => ({}), registerTelemetryPeers,
      composeMain: async () => {
        fail('compose');
        listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('owned') });
        listeners.add(listener);
        return { environment: { lineage: { dataEpoch: 'unit' } }, access: {},
          app: { stop: async () => { await listener!.stop(true); fail('main-stop'); } },
          dependencies: { statementSeek: { projectOnce: async () => fail('project') } },
          templateSeek: { backfill: async () => fail('backfill'), stopRecovery: async () => fail('recovery-stop') } };
      },
    }) as (label: string) => Promise<{ stop(): Promise<void> }>;
    let failed = false, propagatedBefore: boolean | undefined;
    const previousAccountOrigin = process.env.ACCOUNT_ORIGIN;
    if (scenario === 'registration-invalid') Bun.env.ACCOUNT_ORIGIN = 'invalid-url';
    try {
      try {
        const stack = await startMediaStack('telemetry-lifetime');
        propagatedBefore = await propagated(origin);
        await stack.stop();
      } catch { failed = true; }
      results.push({ scenario: `media-${scenario}`, failed, propagatedBefore,
        propagatedAfter: await propagated(origin),
        listenerStopped: await listenerStopped(listener),
        poolsClosed: mediaStartupFailures.includes(scenario) ? undefined : pools.every(pool => pool.closed) });
    } finally {
      if (listener) { await listener.stop(true); listeners.delete(listener); }
      for (const [key, value] of previous) {
        if (value === undefined) delete Bun.env[key]; else Bun.env[key] = value;
      }
      if (scenario === 'registration-invalid') {
        if (previousAccountOrigin === undefined) delete Bun.env.ACCOUNT_ORIGIN;
        else Bun.env.ACCOUNT_ORIGIN = previousAccountOrigin;
      }
    }
  }

  for (const scenario of ['registration-invalid', 'registration-conflict', 'signup', 'listener-stop', 'pool-close']) {
    let listener: ReturnType<typeof Bun.serve> | undefined;
    let poolClosed = false;
    let origin = '';
    const sharedOrigin = 'http://127.0.0.1:43000';
    const releaseShared = registerTelemetryPeers({ MAIN_ORIGIN: sharedOrigin });
    const ratingAccount = fixtureFunction('tests/qa/support/rating-account.ts', 'ratingAccount', {
      Bun, expect, randomBytes, randomUUID, signupPolicyFixture: {}, registerTelemetryPeers,
      sharedAccountPool: fixtureFunction('tests/qa/support/rating-account.ts', 'sharedAccountPool', {
        Pool: class { async end() { poolClosed = true;
          if (scenario === 'pool-close') throw new Error('pool-close'); } },
      }),
      freePort: async () => {
        const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(null) });
        const port = reservation.port!;
        await reservation.stop(true);
        origin = `http://127.0.0.1:${port}`;
        return port;
      },
      getMigrations: async () => ({ runMigrations: async () => {} }), accountAuthOptions: () => ({}),
      installConsentRefreshFence: async () => {}, createAccountAuth: () => ({}),
      createAccountApp: () => ({ listen: (options: { hostname: string; port: number }) => {
        listener = Bun.serve({ ...options, fetch: () => new Response('owned') });
        listeners.add(listener);
        return { handle: async () => new Response(null, { status: 503 }),
          stop: async () => { await listener!.stop(true);
            if (scenario === 'listener-stop') throw new Error('listener-stop'); } };
      } }),
    }) as (apps: Record<string, string>) => Promise<unknown>;
    try {
      let failed = false;
      try { await ratingAccount({ FUSEKI_URL: scenario === 'registration-invalid' ? 'invalid-url'
        : scenario === 'registration-conflict' ? sharedOrigin : 'http://127.0.0.1:43001' }); }
      catch { failed = true; }
      releaseShared();
      results.push({ scenario: `account-${scenario}`, failed, propagatedAfter: await propagated(origin),
        listenerStopped: await listenerStopped(listener), poolsClosed: poolClosed });
      expect(await propagated('http://127.0.0.1:43001')).toBe(false);
      expect(await propagated(sharedOrigin)).toBe(false);
    } finally {
      releaseShared();
      if (listener) { await listener.stop(true); listeners.delete(listener); }
    }
  }
  console.log(JSON.stringify(results));
} finally {
  await Promise.all([...listeners].map(listener => listener.stop(true)));
  await shutdownTelemetry();
  globalThis.fetch = originalFetch;
}
