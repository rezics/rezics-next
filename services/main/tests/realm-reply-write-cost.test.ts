import { createHash, randomUUID } from 'node:crypto';
import { afterAll, expect, test } from 'bun:test';
import type { Pool, PoolClient } from 'pg';
import { startTelemetry, flushTelemetryTraces, shutdownTelemetry, instrumentFetch } from '@rezics/observability/runtime';
import { profileRequest, startWorkProfileSink, type WorkProfile, type WorkSpan } from '../../../tests/qa/support/work-profile.ts';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';

// pg hooks must precede owner imports, and each SDK/sink needs a fresh process.
const costProfileChild = Bun.env.REALM_REPLY_COST_PROFILE_CHILD === '1';
const sink = costProfileChild ? startWorkProfileSink({ settleMs: 25 }) : undefined;
const nativeFetch = globalThis.fetch;
if (sink) startTelemetry('realm-reply-write-cost', { ...process.env, ...sink.env,
  OTEL_SERVICE_NAME: 'realm-reply-write-cost', OTEL_TRACES_SAMPLER_ARG: '0' });
const { foregroundCounted, meterPool, meterFuseki } = await import('../../../tests/qa/integration/support/query-cost-meter.ts');
const pg = await import('pg');
const { signIn } = await import('../../../scripts/lib/oauth-client.ts');
const { agentProvisionHarness } = await import('../../../tests/qa/integration/agent-provision-support.ts');
const { cloneQaOwnerDatabases } = await import('../../../tests/qa/support/databases.ts');
const { createAccountApp } = await import('../../account/src/app.ts');
const { createAccountAuth } = await import('../../account/src/auth.ts');
const { composeMain } = await import('../src/composition.ts');
const { grantFixtureAuthority } = await import('../src/modules/access/fixture-authority.ts');
const { RealmReplyDenied } = await import('../src/modules/realm-reply/content-store.ts');
const { GRAPHS } = await import('../src/modules/work/activate.ts');
const { TargetUnavailable } = await import('../src/modules/target/resolve.ts');
const { WorkReadMissing } = await import('../src/modules/work/read-session.ts');
const { restoreRealmRankingCorpus, timeRealmRankingStage } = await import('./realm-ranking-corpus.ts');
type RealmRankingRestore = Awaited<ReturnType<typeof restoreRealmRankingCorpus>>;
const { realmVisibilityFixture } = await import('./realm-visibility-fixture.ts');
const replyCostScopes = ['agent:create', 'work:create', 'work:edit', 'work:read', 'comment:create', 'realm:adopt'] as const;

afterAll(async () => {
  if (!sink) return;
  try { await shutdownTelemetry(); }
  finally { await sink.stop(); }
});

/** Ceiling evidence per owner and command rejects growth and omitted owner checks.
 * SQL shares are Content persistence, Access authority/disclosure, and Account live verification.
 * The measured 100-thread composition totals 64 Content + 516 Access + 198 Account = 778 SQL.
 * Guard calls retain the legacy convention, including nested graph command wrappers. */
export const REALM_REPLY_WRITE_COST = {
  draft: { content: 14, access: 111, account: 54, statements: 179, fusekiReads: 27, guardCalls: 27 },
  identity: { content: 14, access: 126, account: 54, statements: 194, fusekiReads: 30, guardCalls: 32 },
  review: { content: 12, access: 77, account: 18, statements: 107, fusekiReads: 3, guardCalls: 5 },
  placement: { content: 24, access: 202, account: 72, statements: 298, fusekiReads: 10, guardCalls: 13 },
} as const;

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

type Command = keyof typeof REALM_REPLY_WRITE_COST;
type Count = Record<keyof (typeof REALM_REPLY_WRITE_COST)['draft'], number>;
type Timing = { requestMs: number; accountMs: number; accessMs: number; accountShare: number; accessShare: number };
type CallbackAudit = { countedStatements: number; uncountedStatements: number; issuers: { callsite: string; counted: boolean; statements: number }[] };
type CommandCost = Count & { ms: number; timings: Timing; callbacks: Record<'content' | 'access' | 'account', CallbackAudit> };
type ReplyCost = Count & { ms: number; timings: Timing; commands: Record<Command, CommandCost> };

/** Observe raw callback clients without changing the shared meter. pool.query's
 * internal callback dispatch is already metered; only explicit checkout queries bypass it. */
function auditCallbackCheckouts(pool: Pool) {
  let poolQueryDepth = 0;
  const query = pool.query.bind(pool) as (...args: unknown[]) => unknown;
  const connect = pool.connect.bind(pool) as (...args: unknown[]) => unknown;
  const issuers = new Map<string, CallbackAudit['issuers'][number]>();
  pool.query = ((...args: unknown[]) => {
    poolQueryDepth++;
    try { return query(...args); }
    finally { poolQueryDepth--; }
  }) as Pool['query'];
  pool.connect = ((...args: unknown[]) => {
    if (typeof args[0] !== 'function') return connect(...args);
    // Pool.query dispatches connect synchronously. An async query completion
    // may itself open an explicit callback checkout, which is a different path.
    const counted = poolQueryDepth > 0;
    const callsite = (new Error().stack ?? '').split('\n').find(line =>
      line.includes('/services/') && !line.includes('/tests/'))?.trim() || 'pg-pool Pool.query';
    const callback = args[0] as (error: Error | undefined, client: PoolClient, done: () => void) => void;
    return connect((error: Error | undefined, client: PoolClient, done: () => void) => {
      if (!client) return callback(error, client, done);
      const observed = new Proxy(client, { get(target, property) {
        if (property === 'query') return (...values: unknown[]) => {
          if (foregroundCounted()) {
            const key = `${counted}:${callsite}`;
            const entry = issuers.get(key) ?? { callsite, counted, statements: 0 };
            entry.statements++;
            issuers.set(key, entry);
          }
          return (target.query as (...rest: unknown[]) => unknown).apply(target, values);
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      return callback(error, observed, done);
    });
  }) as Pool['connect'];
  return {
    reset: () => issuers.clear(),
    read: (): CallbackAudit => ({
      countedStatements: [...issuers.values()].filter(entry => entry.counted).reduce((sum, entry) => sum + entry.statements, 0),
      uncountedStatements: [...issuers.values()].filter(entry => !entry.counted).reduce((sum, entry) => sum + entry.statements, 0),
      issuers: [...issuers.values()].map(entry => ({ ...entry })),
    }),
  };
}

/** Interval unions avoid counting parallel owner calls twice. Account is the
 * HTTP wait (including its SQL); Access is SQL wait, not all Main computation.
 * Shares are diagnostic fractions of request server time, never cost caps. */
function ownerTiming(profile: WorkProfile, accessDatabase: string): Timing {
  const ids = new Set(profile.spans.map(span => span.spanId));
  const root = profile.spans.find(span => span.kind === 1 && !ids.has(span.parentSpanId))!;
  const unionMs = (spans: WorkSpan[]) => {
    const intervals = spans.map((span): [number, number] =>
      [Math.max(span.startMs, root.startMs), Math.min(span.endMs, root.endMs)])
      .filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0]);
    let total = 0, end = root.startMs;
    for (const [start, nextEnd] of intervals) {
      total += Math.max(0, nextEnd - Math.max(start, end));
      end = Math.max(end, nextEnd);
    }
    return total;
  };
  const accountMs = unionMs(profile.spans.filter(span => span.kind === 2 && span.attributes['rezics.peer.service'] === 'account'));
  const accessMs = unionMs(profile.spans.filter(span => span.kind === 2 &&
    span.attributes['db.system.name'] === 'postgresql' && span.attributes['db.namespace'] === accessDatabase));
  return { requestMs: profile.serverLatencyMs, accountMs, accessMs,
    accountShare: accountMs / profile.serverLatencyMs, accessShare: accessMs / profile.serverLatencyMs };
}

async function runCostProfileChild() {
  const child = Bun.spawn([process.execPath, 'test', import.meta.filename,
    '--test-name-pattern', '^one reply costs the same per command and owner'], {
    cwd: process.cwd(), env: { ...process.env, REALM_REPLY_COST_PROFILE_CHILD: '1' }, stdout: 'pipe', stderr: 'pipe',
  });
  const timer = setTimeout(() => child.kill(), 360_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    console.log(stdout);
    expect(code, stderr).toBe(0);
  } finally { clearTimeout(timer); }
}

function tallyFuseki(fuseki: FusekiClient) {
  let count = 0;
  for (const method of ['query', 'update', 'command', 'commandWithReceipt', 'commandHealth'] as const) {
    const original = fuseki[method].bind(fuseki) as (...args: unknown[]) => unknown;
    (fuseki as unknown as Record<string, (...args: unknown[]) => unknown>)[method] = (...args: unknown[]) => {
      if (foregroundCounted()) count += 1;
      return original(...args);
    };
  }
  return { get count() { return count }, reset() { count = 0 } };
}

async function completeOwnerFixture(restored: RealmRankingRestore) {
  const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID!, ['account'], 'owner');
  const config = restored.home.stack.composition.config;
  const environment = { ACCOUNT_DATABASE_URL: databases.urls.account,
    ACCESS_DATABASE_URL: config.ACCESS_DATABASE_URL, FUSEKI_URL: restored.fusekiUrl,
    FUSEKI_COMMAND_TOKEN: config.FUSEKI_COMMAND_TOKEN,
    MAIN_DATA_EPOCH: config.MAIN_DATA_EPOCH, MAIN_ROUTING_EPOCH: config.MAIN_ROUTING_EPOCH };
  const previous = new Map(Object.keys(environment).map(key => [key, Bun.env[key]]));
  let fx: Awaited<ReturnType<typeof agentProvisionHarness>>;
  try {
    Object.assign(Bun.env, environment);
    fx = await agentProvisionHarness(replyCostScopes, { offlineAccess: true });
  } catch (error) {
    await databases.close();
    throw error;
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete Bun.env[key]; else Bun.env[key] = value;
    }
  }
  const restoredContent = new pg.Pool({ connectionString: config.CONTENT_DATABASE_URL });
  let accountApp: ReturnType<typeof createAccountApp> | undefined;
  let composition: Awaited<ReturnType<typeof composeMain>> | undefined;
  let restoreFetch: (() => void) | undefined;
  try {
    await fx.accountPool.query('UPDATE "user" SET "emailVerified" = true WHERE id = $1', [fx.user.id]);
    const signedIn = await fetch(`${fx.base}/api/auth/sign-in/email`, { method: 'POST',
      headers: { 'content-type': 'application/json', origin: fx.base },
      body: JSON.stringify({ email: fx.user.email, password: fx.user.password }) });
    expect(signedIn.status).toBe(200);
    const oauth = await signIn({ account: fx.base, clientId: fx.client.client_id, redirectUri: fx.redirectUri,
      scope: `openid offline_access ${replyCostScopes.join(' ')}`,
      resource: Bun.env.ACCOUNT_MAIN_RESOURCE! }, signedIn.headers.get('set-cookie')!);
    expect(oauth.refreshToken).toBeString();
    const currentToken = () => oauth.current(Date.now(), 30_000);
    const callbacks = { content: auditCallbackCheckouts(restoredContent),
      access: auditCallbackCheckouts(fx.accessPool), account: auditCallbackCheckouts(fx.accountPool) };
    const contentPool = meterPool(restoredContent);
    const accessPool = meterPool(fx.accessPool);
    const accountPool = meterPool(fx.accountPool);
    const guard = tallyFuseki(fx.fuseki);
    const fuseki = meterFuseki(fx.fuseki);
    // Rebuild Account over its metered pool before auth captures it in Kysely.
    // The issuer, secret, owner database and saved session/token stay identical.
    await fx.accountApp.stop();
    const auth = createAccountAuth({ baseURL: fx.base, secret: Bun.env.ACCOUNT_SECRET!,
      resource: Bun.env.ACCOUNT_MAIN_RESOURCE!, pool: accountPool, operatorUserIds: new Set() });
    accountApp = createAccountApp(auth, accountPool).listen({ hostname: '127.0.0.1',
      port: Number(new URL(fx.base).port) });
    // The issuer is only known after provisioning. Reconfigure the same production
    // fetch instrumentation with its origin, using native fetch to avoid nested wrappers.
    if (sink) {
      const startupFetch = globalThis.fetch;
      globalThis.fetch = nativeFetch;
      const undo = instrumentFetch(new Set([fx.base, new URL(restored.fusekiUrl).origin]), sink.url,
        new Map([[fx.base, 'account'], [new URL(restored.fusekiUrl).origin, 'fuseki']]));
      restoreFetch = () => { undo(); globalThis.fetch = startupFetch; };
    }
    composition = await composeMain({ config: { ...config,
      ACCOUNT_ISSUER: `${fx.base}/api/auth`, ACCOUNT_JWKS_URL: `${fx.base}/api/auth/jwks`,
      ACCOUNT_INTROSPECT_URL: `${fx.base}/api/auth/oauth2/introspect`,
      ACCOUNT_MAIN_CLIENT_ID: fx.verifierClient.client_id,
      ACCOUNT_MAIN_CLIENT_SECRET: fx.verifierClient.client_secret!,
    }, fuseki, accessPool, contentPool,
      relayPool: restored.home.relay, erasureRelayPool: restored.home.relay,
      ownerRelayPool: restored.home.relay, recommendationRelayPool: restored.home.relay });
    const app = composition.app;
    // The restored Home bearer table is only a smoke-read helper. Provision a
    // real OAuth principal through production so every measured owner keeps its live checks.
    const provisioned = await app.handle(new Request('http://main.local/v1/agents', { method: 'POST',
      headers: { authorization: `Bearer ${await currentToken()}`, 'content-type': 'application/json',
        'idempotency-key': randomUUID() },
      body: JSON.stringify({ profile: 'agent-provision-v1', kind: 'person', displayName: 'Reply cost author' }) }));
    const provision = await provisioned.json() as { agent: string };
    expect(provisioned.status, JSON.stringify(provision)).toBe(201);
    expect(provision.agent).toBeString();
    const actor = restored.manifest.identity.author;
    const principal = await fx.verifier.verify(new Request('http://main.local', {
      headers: { authorization: `Bearer ${await currentToken()}` } }), ['work:read']);
    const principalId = await composition.access.activePrincipalId(principal);
    expect(principalId).toBeString();
    const realm = restored.manifest.identity.realm;
    const work = { work: restored.manifest.identity.work };
    const grant = (subject: string, scope: string, action: string) => grantFixtureAuthority(accessPool, {
      scope, requireDispatch: true,
      // A current controller may differ from the provisioning principal. Keep
      // the corpus author's own-root workload and its product-written provenance.
      representations: [
        { principalId: principalId!, actor: subject, action: 'agent.control', lifetime: 'infinity' },
        { principalId: principalId!, actor: subject, action, lifetime: '8 hours' },
      ],
      grant: { actor: subject, action, lifetime: '8 hours' },
    });
    const draftInput = () => ({ profile: 'member-reply-draft-v1', reply: `https://rezics.com/id/${randomUUID()}`,
      variantId: `urn:rezics:variant:${randomUUID()}`, originRealm: realm,
      rootTarget: work.work, rootRevision: restored.manifest.identity.draftRevision,
      language: 'en', direction: 'ltr', expectedHead: null, body: 'Retained Realm reply cost', actingSubject: actor });
    const call = async (method: string, path: string, body?: object, actingSubject: string | null = actor,
      key = randomUUID(), traceHeaders?: Headers, preparedBearer?: string) => {
      const url = new URL(`http://main.local${path}`);
      if (method === 'GET' && actingSubject) url.searchParams.set('actingSubject', actingSubject);
      const response = await app.handle(new Request(url, { method, headers: {
        ...Object.fromEntries(traceHeaders ?? []),
        ...(actingSubject ? { authorization: `Bearer ${preparedBearer ?? await currentToken()}` } : {}),
        'content-type': 'application/json', 'idempotency-key': key,
      }, body: body ? JSON.stringify(body) : undefined }));
      return { status: response.status, headers: response.headers,
        body: await response.json() as Record<string, any> };
    };
    return { ...fx, app, call, actor, realm, work, grant, draftInput, oauth, currentToken,
      env: composition.environment, access: composition.access,
      content: composition.content, contentPool, accessPool, accountPool, guard, fuseki, callbacks,
      close: async () => {
        try { await app.stop(); }
        finally {
          try { await accountApp!.stop(); }
          finally {
            restoreFetch?.();
            try { await Promise.all([restoredContent.end(), fx.close()]); }
            finally { await databases.close(); }
          }
        }
      } };
  } catch (error) {
    try { await composition?.app.stop(); }
    finally {
      try { await accountApp?.stop(); }
      finally {
        restoreFetch?.();
        try { await Promise.all([restoredContent.end(), fx.close()]); }
        finally { await databases.close(); }
      }
    }
    throw error;
  }
}

// Both cuts were built once through reply commands. Each measurement restores
// isolated owner stores and adds only a warm-up reply and the measured reply.
async function measureRetainedReplyCost(size: 100 | 1600): Promise<ReplyCost> {
  const restored = await restoreRealmRankingCorpus(size);
  const fx = await timeRealmRankingStage('production-setup', () => completeOwnerFixture(restored),
    { threads: size, target: restored.target }).catch(async error => {
    await restored.close();
    throw error;
  });
  try {
    // A positive control proves the diagnostic sees the shared meter's gap;
    // pool.query's own callback dispatch remains counted exactly once.
    fx.contentPool.reset(); fx.callbacks.content.reset();
    await new Promise<void>((resolve, reject) => fx.contentPool.connect((error, client, release) => {
      if (error || !client) return reject(error ?? new Error('callback checkout returned no client'));
      client.query('SELECT 1', queryError => {
        release();
        if (queryError) reject(queryError); else resolve();
      });
    }));
    expect(fx.contentPool.queries).toBe(0);
    expect(fx.callbacks.content.read().uncountedStatements).toBe(1);
    await fx.contentPool.query('SELECT 1');
    expect(fx.contentPool.queries).toBe(1);
    expect(fx.callbacks.content.read().countedStatements).toBe(1);
    await fx.grant(fx.actor, `review:decide:${fx.realm}`, 'review.decide');
    await fx.grant(fx.actor, `reply:place:${fx.realm}`, 'reply.place');
    const accessDatabase = (await fx.accessPool.query<{ database: string }>('SELECT current_database() AS database')).rows[0]!.database;
    const read = (): Count => ({
      statements: fx.contentPool.queries + fx.accessPool.queries + fx.accountPool.queries,
      fusekiReads: fx.fuseki.queries, guardCalls: fx.guard.count,
      content: fx.contentPool.queries, access: fx.accessPool.queries, account: fx.accountPool.queries,
    });
    const reset = () => {
      fx.contentPool.reset(); fx.accessPool.reset(); fx.accountPool.reset(); fx.fuseki.reset(); fx.guard.reset();
      for (const audit of Object.values(fx.callbacks)) audit.reset();
    };
    const postReply = async (measured = false): Promise<{ reply: string; revision: string; cost: ReplyCost }> => {
      const input = fx.draftInput();
      const commands = {} as ReplyCost['commands'];
      const step = async (name: Command, path: string, body: object) => {
        // OAuth rotation is fixture preparation, before both the counter reset
        // and the request trace. The measured command retains its live checks.
        const previousToken = fx.oauth.accessToken;
        const bearer = await fx.currentToken();
        if (fx.oauth.accessToken !== previousToken)
          console.log(JSON.stringify({ realmReplyFixtureOAuthRefresh: { beforeCommand: name, minimumValidityMs: 30_000 } }));
        reset();
        const { result: response, profile } = await profileRequest(sink!, headers =>
          fx.call('POST', path, body, fx.actor, randomUUID(), headers, bearer), { flush: flushTelemetryTraces });
        const callbacks = { content: fx.callbacks.content.read(), access: fx.callbacks.access.read(), account: fx.callbacks.account.read() };
        const counted = read();
        commands[name] = { ...counted, ms: profile.totalLatencyMs, timings: ownerTiming(profile, accessDatabase), callbacks };
        expect(response.status, `${name} ${JSON.stringify(response.body)}`).toBe(201);
        if (profile.postgresStatements !== counted.statements) {
          const sqlByDatabase: Record<string, number> = {};
          for (const span of profile.spans.filter(span => span.kind === 2 && span.attributes['db.system.name'] === 'postgresql')) {
            const database = String(span.attributes['db.namespace']);
            sqlByDatabase[database] = (sqlByDatabase[database] ?? 0) + 1;
          }
          await Bun.write('.temp/realm-reply-trace-diagnostic.json', JSON.stringify({ name, counted, callbacks, sqlByDatabase, profile }, null, 2));
        }
        if (measured) {
          // Cold startup ticks can inherit the request trace while the shared
          // meter excludes them. Only the warmed, reported replies must agree.
          expect(profile.postgresStatements, `${name}: owner SQL trace is incomplete`).toBe(counted.statements);
          expect(profile.spans.filter(span => span.kind === 2 && span.attributes['db.system.name'] === 'postgresql' &&
            span.attributes['db.namespace'] === accessDatabase).length, `${name}: Access timing spans are incomplete`).toBe(counted.access);
        }
        expect(profile.accountCalls, `${name}: Account timing spans are missing`).toBeGreaterThan(0);
        for (const [owner, audit] of Object.entries(callbacks))
          expect(audit.uncountedStatements, `${name} ${owner}: ${JSON.stringify(audit.issuers)}`).toBe(0);
        return response.body;
      };
      const draft = await step('draft', '/v1/member-reply-drafts', input);
      const identity = await step('identity', '/v1/realm-replies', {
        profile: 'realm-reply-identity-v1', reply: input.reply, variantId: input.variantId,
        revisionId: draft.revisionId, author: fx.actor, rootTarget: input.rootTarget,
        rootRevision: input.rootRevision, parentReply: null, parentRevision: null, contextRevision: null,
      });
      const review = await step('review', '/v1/realm-reply-reviews', {
        profile: 'realm-reply-review-v1', realm: fx.realm, reply: input.reply,
        revisionId: draft.revisionId, revisionDigest: draft.revisionDigest, expectedGeneration: '0',
        supersedes: null, outcome: 'approved', method: 'human', methodRevision: 'realm-manager-v1',
        dependencyDigest: sha(fx.work.work), reasonReference: null, actingSubject: fx.actor,
      });
      await step('placement', '/v1/realm-reply-placements', {
        profile: 'realm-reply-placement-v1', realm: fx.realm, reply: input.reply,
        revisionId: draft.revisionId, revisionDigest: draft.revisionDigest,
        reviewDecisionId: review.decisionId, expectedHead: null, actingSubject: fx.actor,
      });
      const timingTotals = Object.values(commands).reduce((sum, command) => ({
        requestMs: sum.requestMs + command.timings.requestMs,
        accountMs: sum.accountMs + command.timings.accountMs,
        accessMs: sum.accessMs + command.timings.accessMs,
      }), { requestMs: 0, accountMs: 0, accessMs: 0 });
      const cost = {
        statements: Object.values(commands).reduce((sum, command) => sum + command.statements, 0),
        fusekiReads: Object.values(commands).reduce((sum, command) => sum + command.fusekiReads, 0),
        guardCalls: Object.values(commands).reduce((sum, command) => sum + command.guardCalls, 0),
        content: Object.values(commands).reduce((sum, command) => sum + command.content, 0),
        access: Object.values(commands).reduce((sum, command) => sum + command.access, 0),
        account: Object.values(commands).reduce((sum, command) => sum + command.account, 0),
        ms: Object.values(commands).reduce((sum, command) => sum + command.ms, 0), commands,
        timings: { ...timingTotals, accountShare: timingTotals.accountMs / timingTotals.requestMs,
          accessShare: timingTotals.accessMs / timingTotals.requestMs },
      };
      return { reply: identity.reply as string, revision: draft.revisionId as string, cost };
    };

    const roots = await fx.contentPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM content.reply WHERE root_target=$1 AND parent_reply IS NULL',
      [fx.work.work]);
    expect(Number(roots.rows[0]!.count), 'retained Content root-thread population').toBe(size);
    const slotCensus = `PREFIX rv: <https://rezics.com/vocab/>
      SELECT (COUNT(DISTINCT ?slot) AS ?count) WHERE {
        GRAPH <${GRAPHS.current}> { ?slot a rv:RealmReplySlot ;
          rv:realm <${fx.realm}> ; rv:replyPlacementHead ?head }
      }`;
    const slots = await fx.fuseki.query(slotCensus);
    const populatedSlots = Number(slots.results?.bindings?.[0]?.count?.value);
    expect(populatedSlots, 'retained graph population must agree with the owner cut')
      .toBe(size + (size === 1600 ? restored.manifest.identity.deepChain.length : 0));
    console.log(JSON.stringify({ realmReplyRetainedPopulation: { cut: size,
      rootThreads: Number(roots.rows[0]!.count), populatedSlots } }));
    await timeRealmRankingStage('production-warmup', () => postReply(), { threads: size, target: restored.target });
    const warmedRoots = await fx.contentPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM content.reply WHERE root_target=$1 AND parent_reply IS NULL',
      [fx.work.work]);
    const warmedSlots = await fx.fuseki.query(slotCensus);
    const measuredRootThreads = Number(warmedRoots.rows[0]!.count);
    const measuredSlots = Number(warmedSlots.results?.bindings?.[0]?.count?.value);
    expect(measuredRootThreads).toBe(size + 1);
    expect(measuredSlots).toBe(populatedSlots + 1);
    const cost = (await timeRealmRankingStage('production-measurement', () => postReply(true),
      { threads: size, target: restored.target })).cost;
    console.log(JSON.stringify({ realmReplyWriteCostCheckpoint: { cut: size,
      measuredRootThreads, measuredSlots, cost } }));

    if (size === 1600) {
      const original = fx.fuseki.commandWithReceipt.bind(fx.fuseki);
      let failCancels = 0;
      fx.fuseki.commandWithReceipt = async (envelope) => {
        if (failCancels > 0 && envelope.update.includes('rv:outcome rv:Cancelled')) {
          failCancels -= 1;
          throw new Error('placement cancellation transport failed');
        }
        return original(envelope);
      };
      const poisoned = fx.draftInput();
      const poisonedDraft = await fx.call('POST', '/v1/member-reply-drafts', poisoned);
      expect(poisonedDraft.status, JSON.stringify(poisonedDraft.body)).toBe(201);
      const poisonedKey = randomUUID();
      failCancels = 1;
      const lost = await fx.call('POST', '/v1/realm-replies', {
        profile: 'realm-reply-identity-v1', reply: poisoned.reply, variantId: poisoned.variantId,
        revisionId: poisonedDraft.body.revisionId, author: fx.actor, rootTarget: poisoned.rootTarget,
        rootRevision: poisoned.rootRevision, parentReply: `https://rezics.com/id/${randomUUID()}`,
        parentRevision: randomUUID(), contextRevision: null,
      }, fx.actor, poisonedKey);
      expect(lost.status, JSON.stringify(lost.body)).toBe(503);
      const admission = await fx.accessPool.query<{ id: string }>(
        `SELECT id FROM access.admission WHERE idempotency_key = $1 AND action = 'reply.create'`, [poisonedKey]);
      expect(admission.rowCount).toBe(1);
      const receipt = await fx.contentPool.query<{ outcome: string }>(
        'SELECT outcome FROM content.receipt WHERE operation_id = $1', [admission.rows[0]!.id]);
      expect(receipt.rows[0]?.outcome).toBe('rejected');
      const next = await postReply();
      expect(next.reply.startsWith('https://rezics.com/id/')).toBe(true);
    }
    return cost;
  } finally {
    try { await fx.close(); }
    finally { await restored.close(); }
  }
}

test('one reply costs the same per command and owner at retained 100 and 1,600-thread cuts', async () => {
  if (!costProfileChild) return runCostProfileChild();
  const at100 = await measureRetainedReplyCost(100);
  const at1600 = await measureRetainedReplyCost(1600);
  console.log(JSON.stringify({ realmReplyWriteCost: { at100, at1600 } }));
  const counted = (cost: ReplyCost) => ({
    statements: cost.statements, fusekiReads: cost.fusekiReads, guardCalls: cost.guardCalls,
    content: cost.content, access: cost.access, account: cost.account,
    commands: Object.fromEntries(Object.entries(cost.commands).map(([name, command]) => [name, {
      statements: command.statements, fusekiReads: command.fusekiReads, guardCalls: command.guardCalls,
      content: command.content, access: command.access, account: command.account,
    }])),
  });
  expect(counted(at1600), JSON.stringify({ at100, at1600 })).toEqual(counted(at100));
  for (const cost of [at100, at1600]) {
    expect(cost.statements).toBeLessThanOrEqual(778);
    expect(cost.fusekiReads).toBeLessThanOrEqual(70);
    expect(cost.guardCalls).toBeLessThanOrEqual(77);
    for (const name of Object.keys(REALM_REPLY_WRITE_COST) as Command[]) {
      const command = cost.commands[name];
      for (const metric of Object.keys(REALM_REPLY_WRITE_COST[name]) as (keyof Count)[]) {
        expect(command[metric], `${name} ${metric}: ${JSON.stringify(command)}`)
          .toBeLessThanOrEqual(REALM_REPLY_WRITE_COST[name][metric]);
      }
    }
  }
}, 420_000);

test('a same-key create during cancellation cannot leave a live identity under a cancelled graph', async () => {
  const fx = await realmVisibilityFixture();
  const query = fx.fuseki.query.bind(fx.fuseki);
  const command = fx.fuseki.commandWithReceipt.bind(fx.fuseki);
  try {
    const draftInput = fx.draftInput();
    const draft = await fx.call('POST', '/v1/member-reply-drafts', draftInput);
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    const body = {
      profile: 'realm-reply-identity-v1', reply: draftInput.reply, variantId: draftInput.variantId,
      revisionId: draft.body.revisionId, author: fx.actor, rootTarget: draftInput.rootTarget,
      rootRevision: draftInput.rootRevision, parentReply: null, parentRevision: null, contextRevision: null,
    };
    const key = randomUUID();
    const arm = { on: false };
    let failedRoot = false;
    let pausedCancel = false;
    let releaseCancel = () => {};
    const cancelPaused = new Promise<void>(resolve => {
      const connect = fx.accessPool.connect.bind(fx.accessPool) as (...args: unknown[]) => unknown;
      const seen = new WeakSet<object>();
      const wrap = (client: PoolClient) => {
        if (seen.has(client)) return;
        seen.add(client);
        const original = client.query.bind(client) as (...args: unknown[]) => unknown;
        client.query = ((...args: unknown[]) => {
          const text = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string } | undefined)?.text;
          if (typeof text === 'string' && text.includes("'admission.claimed'")) arm.on = true;
          return original(...args);
        }) as PoolClient['query'];
      };
      fx.accessPool.connect = ((...args: unknown[]) => {
        if (typeof args[0] === 'function') {
          const callback = args[0] as (error: Error | undefined, client: PoolClient, done: () => void) => void;
          return connect((error: Error | undefined, client: PoolClient, done: () => void) => {
            if (client) wrap(client);
            callback(error, client, done);
          });
        }
        return Promise.resolve(connect()).then(client => {
          wrap(client as PoolClient);
          return client;
        });
      }) as Pool['connect'];
      resolve();
    });
    await cancelPaused;
    fx.fuseki.query = async (sparql, limit) => {
      if (arm.on && !failedRoot && sparql.includes('rv:ErasedRevision')) {
        failedRoot = true;
        // An authority refusal still cancels. A dependency failure must not.
        throw new RealmReplyDenied('parent is not an exact reply');
      }
      return query(sparql, limit);
    };
    const release = new Promise<void>(resolve => { releaseCancel = resolve; });
    fx.fuseki.commandWithReceipt = async (envelope) => {
      if (!pausedCancel && envelope.update.includes('rv:outcome rv:Cancelled')) {
        pausedCancel = true;
        await release;
      }
      return command(envelope);
    };
    const canceller = fx.call('POST', '/v1/realm-replies', body, fx.actor, key);
    const started = Date.now();
    while (!pausedCancel) {
      if (Date.now() - started > 60_000) throw new Error('cancellation did not reach the graph command');
      await Bun.sleep(20);
    }
    const racer = await fx.call('POST', '/v1/realm-replies', body, fx.actor, key);
    releaseCancel();
    const cancelled = await canceller;
    expect(racer.status, JSON.stringify(racer.body)).not.toBe(201);
    expect(cancelled.status, JSON.stringify(cancelled.body)).not.toBe(201);
    const admission = await fx.accessPool.query<{ id: string; graph_outcome: string | null }>(
      `SELECT id, graph_outcome FROM access.admission WHERE idempotency_key = $1 AND action = 'reply.create'`, [key]);
    expect(admission.rowCount).toBe(1);
    const receipt = await fx.contentPool.query<{ outcome: string }>(
      'SELECT outcome FROM content.receipt WHERE operation_id = $1', [admission.rows[0]!.id]);
    const live = await fx.contentPool.query('SELECT 1 FROM content.reply WHERE id = $1', [body.reply]);
    const identity = receipt.rows[0]?.outcome === 'succeeded' && (live.rowCount ?? 0) > 0;
    expect(admission.rows[0]!.graph_outcome === 'cancelled' && identity).toBe(false);
    expect(receipt.rows[0]?.outcome).toBe('rejected');
    expect(live.rowCount).toBe(0);
    expect(admission.rows[0]!.graph_outcome).toBe('cancelled');
  } finally {
    fx.fuseki.query = query;
    fx.fuseki.commandWithReceipt = command;
    await fx.close();
  }
}, 120_000);

test('a transient target unavailability leaves the same identity key retryable', async () => {
  const fx = await realmVisibilityFixture();
  const query = fx.fuseki.query.bind(fx.fuseki);
  const previousConnect = fx.accessPool.connect;
  try {
    const draftInput = fx.draftInput();
    const draft = await fx.call('POST', '/v1/member-reply-drafts', draftInput);
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    const body = {
      profile: 'realm-reply-identity-v1', reply: draftInput.reply, variantId: draftInput.variantId,
      revisionId: draft.body.revisionId, author: fx.actor, rootTarget: draftInput.rootTarget,
      rootRevision: draftInput.rootRevision, parentReply: null, parentRevision: null, contextRevision: null,
    };
    const key = randomUUID();
    const arm = { on: false };
    let failed = false;
    const connect = fx.accessPool.connect.bind(fx.accessPool) as (...args: unknown[]) => unknown;
    const seen = new WeakSet<object>();
    const wrap = (client: PoolClient) => {
      if (seen.has(client)) return;
      seen.add(client);
      const original = client.query.bind(client) as (...args: unknown[]) => unknown;
      client.query = ((...args: unknown[]) => {
        const text = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string } | undefined)?.text;
        if (typeof text === 'string' && text.includes("'admission.claimed'")) arm.on = true;
        return original(...args);
      }) as PoolClient['query'];
    };
    fx.accessPool.connect = ((...args: unknown[]) => {
      if (typeof args[0] === 'function') {
        const callback = args[0] as (error: Error | undefined, client: PoolClient, done: () => void) => void;
        return connect((error: Error | undefined, client: PoolClient, done: () => void) => {
          if (client) wrap(client);
          callback(error, client, done);
        });
      }
      return Promise.resolve(connect()).then(client => {
        wrap(client as PoolClient);
        return client;
      });
    }) as Pool['connect'];
    fx.fuseki.query = async (sparql, limit) => {
      if (arm.on && !failed && sparql.includes('rv:ErasedRevision')) {
        failed = true;
        throw new TargetUnavailable();
      }
      return query(sparql, limit);
    };
    const first = await fx.call('POST', '/v1/realm-replies', body, fx.actor, key);
    expect(first.status, JSON.stringify(first.body)).toBe(503);
    const admission = await fx.accessPool.query<{ id: string; graph_outcome: string | null }>(
      `SELECT id, graph_outcome FROM access.admission WHERE idempotency_key = $1 AND action = 'reply.create'`, [key]);
    expect(admission.rowCount).toBe(1);
    expect(admission.rows[0]!.graph_outcome).toBeNull();
    const rejected = await fx.contentPool.query(
      `SELECT 1 FROM content.receipt WHERE operation_id = $1 AND outcome = 'rejected'`, [admission.rows[0]!.id]);
    expect(rejected.rowCount).toBe(0);
    const retry = await fx.call('POST', '/v1/realm-replies', body, fx.actor, key);
    expect(retry.status, JSON.stringify(retry.body)).toBe(201);
    const live = await fx.contentPool.query('SELECT 1 FROM content.reply WHERE id = $1', [body.reply]);
    expect(live.rowCount).toBe(1);
  } finally {
    fx.accessPool.connect = previousConnect;
    fx.fuseki.query = query;
    await fx.close();
  }
}, 120_000);

test('an unreadable reply root writes no admission, receipt, or graph command', async () => {
  const fx = await realmVisibilityFixture();
  const command = fx.fuseki.command.bind(fx.fuseki);
  const withReceipt = fx.fuseki.commandWithReceipt.bind(fx.fuseki);
  let commands = 0;
  fx.fuseki.command = (async (...args: Parameters<FusekiClient['command']>) => {
    commands += 1;
    return command(...args);
  }) as FusekiClient['command'];
  fx.fuseki.commandWithReceipt = (async (...args: Parameters<FusekiClient['commandWithReceipt']>) => {
    commands += 1;
    return withReceipt(...args);
  }) as FusekiClient['commandWithReceipt'];
  try {
    const key = randomUUID();
    const response = await fx.call('POST', '/v1/realm-replies', {
      profile: 'realm-reply-identity-v1', reply: `https://rezics.com/id/${randomUUID()}`,
      variantId: `urn:rezics:variant:${randomUUID()}`, revisionId: randomUUID(), author: fx.actor,
      rootTarget: `https://rezics.com/id/${randomUUID()}`, rootRevision: `https://rezics.com/id/${randomUUID()}`,
      parentReply: null, parentRevision: null, contextRevision: null,
    }, fx.actor, key);
    expect(response.status, JSON.stringify(response.body)).toBe(404);
    expect(commands).toBe(0);
    const admission = await fx.accessPool.query<{ id: string }>(
      `SELECT id FROM access.admission WHERE idempotency_key = $1`, [key]);
    expect(admission.rowCount).toBe(0);
    const receipt = admission.rows[0]
      ? await fx.contentPool.query('SELECT 1 FROM content.receipt WHERE operation_id = $1', [admission.rows[0].id])
      : { rowCount: 0 };
    expect(receipt.rowCount).toBe(0);
  } finally {
    fx.fuseki.command = command;
    fx.fuseki.commandWithReceipt = withReceipt;
    await fx.close();
  }
}, 120_000);

function sqlText(args: unknown[]): string | undefined {
  const first = args[0];
  if (typeof first === 'string') return first;
  if (first && typeof first === 'object' && 'text' in first && typeof first.text === 'string') return first.text;
  return undefined;
}

test('an unavailable reply question is denied before any admission or graph command', async () => {
  const fx = await realmVisibilityFixture();
  const query = fx.fuseki.query.bind(fx.fuseki);
  const command = fx.fuseki.command.bind(fx.fuseki);
  const withReceipt = fx.fuseki.commandWithReceipt.bind(fx.fuseki);
  try {
    const input = fx.draftInput();
    const draft = await fx.call('POST', '/v1/member-reply-drafts', input);
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    const body = {
      profile: 'realm-reply-identity-v1', reply: input.reply, variantId: input.variantId,
      revisionId: draft.body.revisionId, author: fx.actor, rootTarget: input.rootTarget,
      rootRevision: input.rootRevision, parentReply: null, parentRevision: null,
      contextRevision: `https://rezics.com/id/${randomUUID()}`,
    };
    let commands = 0;
    let missed = false;
    fx.fuseki.query = async (sparql, limit) => {
      if (sparql.includes('SELECT ?context') && sparql.includes(body.contextRevision)) {
        missed = true;
        throw new WorkReadMissing('Reply question is unavailable');
      }
      return query(sparql, limit);
    };
    fx.fuseki.command = (async (...args: Parameters<FusekiClient['command']>) => {
      commands += 1;
      return command(...args);
    }) as FusekiClient['command'];
    fx.fuseki.commandWithReceipt = (async (...args: Parameters<FusekiClient['commandWithReceipt']>) => {
      commands += 1;
      return withReceipt(...args);
    }) as FusekiClient['commandWithReceipt'];
    const key = randomUUID();
    const denied = await fx.call('POST', '/v1/realm-replies', body, fx.actor, key);
    expect(missed).toBe(true);
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    expect(denied.body.code).toBe('realm_reply_denied');
    expect(commands).toBe(0);
    expect((await fx.accessPool.query(
      'SELECT id FROM access.admission WHERE idempotency_key = $1', [key])).rowCount).toBe(0);
    expect((await fx.contentPool.query(
      'SELECT 1 FROM content.reply WHERE id = $1', [input.reply])).rowCount).toBe(0);
    fx.fuseki.query = query;
    const retry = await fx.call('POST', '/v1/realm-replies', body, fx.actor, key);
    expect(retry.status, JSON.stringify(retry.body)).toBe(201);
  } finally {
    fx.fuseki.query = query;
    fx.fuseki.command = command;
    fx.fuseki.commandWithReceipt = withReceipt;
    await fx.close();
  }
}, 120_000);

function sqlValues(args: unknown[]): unknown[] {
  const first = args[0];
  if (typeof first === 'string') return Array.isArray(args[1]) ? args[1] as unknown[] : [];
  if (first && typeof first === 'object' && 'values' in first && Array.isArray(first.values)) return first.values as unknown[];
  return [];
}

/** The placement callback holds the admission until the claim after the pin
 * commits. Another connection cannot change that row in time for the claim to
 * see it, so the change runs on the claim's own client. */
function armSecondClaim(access: Pool, content: Pool,
  change: (query: PoolClient['query'], admissionId: string) => Promise<void>): () => void {
  const restore: Array<() => void> = [];
  const wrap = (pool: Pool, install: (query: (...args: unknown[]) => unknown) => PoolClient['query']) => {
    const connect = pool.connect.bind(pool) as (...args: unknown[]) => unknown;
    const seen = new WeakSet<object>();
    const wrapClient = (client: PoolClient) => {
      if (seen.has(client)) return;
      seen.add(client);
      const query = client.query.bind(client) as (...args: unknown[]) => unknown;
      client.query = install(query);
    };
    pool.connect = ((...args: unknown[]) => {
      if (typeof args[0] === 'function') {
        const callback = args[0] as (error: Error | undefined, client: PoolClient, done: () => void) => void;
        return connect((error: Error | undefined, client: PoolClient, done: () => void) => {
          if (client) wrapClient(client);
          callback(error, client, done);
        });
      }
      return Promise.resolve(connect()).then(client => {
        wrapClient(client as PoolClient);
        return client;
      });
    }) as Pool['connect'];
    restore.push(() => { pool.connect = connect as Pool['connect']; });
  };
  let prepared = false;
  let changed = false;
  wrap(content, query => ((...args: unknown[]) => {
    const pending = query(...args);
    if (prepared || !sqlText(args)?.includes('INSERT INTO content.publication_preparation')) return pending;
    return Promise.resolve(pending).then(value => {
      prepared = true;
      return value;
    });
  }) as PoolClient['query']);
  wrap(access, query => ((...args: unknown[]) => {
    const text = sqlText(args);
    if (!changed && prepared && text?.includes('SELECT scope_id, action FROM access.admission WHERE id')) {
      changed = true;
      const admissionId = String(sqlValues(args)[0]);
      return Promise.resolve(change(query as PoolClient['query'], admissionId)).then(() => query(...args));
    }
    return query(...args);
  }) as PoolClient['query']);
  return () => { for (const undo of restore) undo(); };
}

async function reviewedPlacement(fx: Awaited<ReturnType<typeof realmVisibilityFixture>>) {
  await fx.grant(fx.actor, `review:decide:${fx.realm}`, 'review.decide');
  await fx.grant(fx.actor, `reply:place:${fx.realm}`, 'reply.place');
  const input = fx.draftInput();
  const draft = await fx.call('POST', '/v1/member-reply-drafts', input);
  expect(draft.status, JSON.stringify(draft.body)).toBe(201);
  const identity = await fx.call('POST', '/v1/realm-replies', {
    profile: 'realm-reply-identity-v1', reply: input.reply, variantId: input.variantId,
    revisionId: draft.body.revisionId, author: fx.actor, rootTarget: input.rootTarget,
    rootRevision: input.rootRevision, parentReply: null, parentRevision: null, contextRevision: null,
  });
  expect(identity.status, JSON.stringify(identity.body)).toBe(201);
  const review = await fx.call('POST', '/v1/realm-reply-reviews', {
    profile: 'realm-reply-review-v1', realm: fx.realm, reply: input.reply,
    revisionId: draft.body.revisionId, revisionDigest: draft.body.revisionDigest, expectedGeneration: '0',
    supersedes: null, outcome: 'approved', method: 'human', methodRevision: 'realm-manager-v1',
    dependencyDigest: sha(fx.work.work), reasonReference: null, actingSubject: fx.actor,
  });
  expect(review.status, JSON.stringify(review.body)).toBe(201);
  return {
    profile: 'realm-reply-placement-v1', realm: fx.realm, reply: input.reply,
    revisionId: draft.body.revisionId, revisionDigest: draft.body.revisionDigest,
    reviewDecisionId: review.body.decisionId, expectedHead: null, actingSubject: fx.actor,
  };
}

async function expectRefusedPlacement(fx: Awaited<ReturnType<typeof realmVisibilityFixture>>,
  body: Awaited<ReturnType<typeof reviewedPlacement>>, key: ReturnType<typeof randomUUID>, status: number) {
  const first = await fx.call('POST', '/v1/realm-reply-placements', body, fx.actor, key);
  expect(first.status, JSON.stringify(first.body)).toBe(status);
  const admission = await fx.accessPool.query<{ id: string; state: string; graph_outcome: string | null }>(
    `SELECT id, state, graph_outcome FROM access.admission WHERE idempotency_key = $1 AND action = 'reply.place'`, [key]);
  expect(admission.rowCount).toBe(1);
  expect(admission.rows[0]).toMatchObject({ state: 'sealed', graph_outcome: 'cancelled' });
  const pin = await fx.contentPool.query<{ status: string; pin_active: boolean }>(
    'SELECT status, pin_active FROM content.publication_preparation WHERE operation_id = $1',
    [admission.rows[0]!.id]);
  expect(pin.rows).toEqual([{ status: 'rejected', pin_active: false }]);
  const retry = await fx.call('POST', '/v1/realm-reply-placements', body, fx.actor, key);
  expect(retry.status, JSON.stringify(retry.body)).not.toBe(503);
  expect([403, 409]).toContain(retry.status);
  const again = await fx.accessPool.query<{ state: string; graph_outcome: string | null }>(
    'SELECT state, graph_outcome FROM access.admission WHERE id = $1', [admission.rows[0]!.id]);
  expect(again.rows[0]).toMatchObject({ state: 'sealed', graph_outcome: 'cancelled' });
}

test('a nested reply identity requires the same Realm origin as its exact parent', async () => {
  const fx = await realmVisibilityFixture();
  try {
    const parent = await fx.reply(fx.actor, fx.realm);
    await fx.grant(fx.actor, `review:decide:${fx.realm}`, 'review.decide');
    await fx.grant(fx.actor, `reply:place:${fx.realm}`, 'reply.place');
    const review = await fx.call('POST', '/v1/realm-reply-reviews', {
      profile: 'realm-reply-review-v1', realm: fx.realm, reply: parent.input.reply,
      revisionId: parent.draft.body.revisionId, revisionDigest: parent.draft.body.revisionDigest,
      expectedGeneration: '0', supersedes: null, outcome: 'approved', method: 'human',
      methodRevision: 'realm-manager-v1', dependencyDigest: sha(fx.work.work), reasonReference: null,
      actingSubject: fx.actor,
    });
    expect(review.status, JSON.stringify(review.body)).toBe(201);
    const placed = await fx.call('POST', '/v1/realm-reply-placements', {
      ...parent.placement, reviewDecisionId: review.body.decisionId,
    });
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);

    const nested = async (originRealm: string | null) => {
      const input = fx.draftInput(fx.actor, originRealm);
      const draft = await fx.call('POST', '/v1/member-reply-drafts', input);
      expect(draft.status, JSON.stringify(draft.body)).toBe(201);
      return fx.call('POST', '/v1/realm-replies', {
        profile: 'realm-reply-identity-v1', reply: input.reply, variantId: input.variantId,
        revisionId: draft.body.revisionId, author: fx.actor, rootTarget: input.rootTarget,
        rootRevision: input.rootRevision, parentReply: parent.input.reply,
        parentRevision: parent.draft.body.revisionId, contextRevision: null,
      });
    };

    const matching = await nested(fx.realm);
    expect(matching.status, JSON.stringify(matching.body)).toBe(201);
    const mismatched = await nested(null);
    expect(mismatched.status, JSON.stringify(mismatched.body)).toBe(403);
  } finally {
    await fx.close();
  }
});

test('an expired admission retry is refused and sealed with the placement pin released', async () => {
  const fx = await realmVisibilityFixture();
  let restore = () => {};
  try {
    const body = await reviewedPlacement(fx);
    const key = randomUUID();
    restore = armSecondClaim(fx.accessPool, fx.contentPool, (query, admissionId) => query(
      `UPDATE access.admission SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1`,
      [admissionId]).then(() => undefined));
    await expectRefusedPlacement(fx, body, key, 409);
  } finally {
    restore();
    await fx.close();
  }
}, 120_000);

function watchAdmissionClaim(pool: Pool): { claimed: { on: boolean }; restore: () => void } {
  const claimed = { on: false };
  const connect = pool.connect.bind(pool) as (...args: unknown[]) => unknown;
  const seen = new WeakSet<object>();
  const wrap = (client: PoolClient) => {
    if (seen.has(client)) return;
    seen.add(client);
    const original = client.query.bind(client) as (...args: unknown[]) => unknown;
    client.query = ((...args: unknown[]) => {
      if (sqlText(args)?.includes("'admission.claimed'")) claimed.on = true;
      return original(...args);
    }) as PoolClient['query'];
  };
  pool.connect = ((...args: unknown[]) => {
    if (typeof args[0] === 'function') {
      const callback = args[0] as (error: Error | undefined, client: PoolClient, done: () => void) => void;
      return connect((error: Error | undefined, client: PoolClient, done: () => void) => {
        if (client) wrap(client);
        callback(error, client, done);
      });
    }
    return Promise.resolve(connect()).then(client => {
      wrap(client as PoolClient);
      return client;
    });
  }) as Pool['connect'];
  return { claimed, restore: () => { pool.connect = connect as Pool['connect']; } };
}

test('a reply draft keeps the same key open until its root is visible', async () => {
  const fx = await realmVisibilityFixture();
  const query = fx.fuseki.query.bind(fx.fuseki);
  try {
    const input = fx.draftInput();
    const key = randomUUID();
    let hidden = true;
    fx.fuseki.query = async (sparql, limit) => {
      if (hidden && sparql.includes(input.rootTarget) && sparql.includes('rv:ErasedRevision')) {
        hidden = false;
        throw new WorkReadMissing('Reply root is unavailable');
      }
      return query(sparql, limit);
    };
    const first = await fx.call('POST', '/v1/member-reply-drafts', input, fx.actor, key);
    expect(first.status, JSON.stringify(first.body)).toBe(404);
    const admission = await fx.accessPool.query(
      'SELECT id FROM access.admission WHERE idempotency_key = $1', [key]);
    expect(admission.rowCount).toBe(0);
    const retry = await fx.call('POST', '/v1/member-reply-drafts', input, fx.actor, key);
    expect(retry.status, JSON.stringify(retry.body)).toBe(201);
  } finally {
    fx.fuseki.query = query;
    await fx.close();
  }
}, 120_000);

test('a reply draft lost after its key is claimed stays unsealed until the root is visible', async () => {
  const fx = await realmVisibilityFixture();
  const query = fx.fuseki.query.bind(fx.fuseki);
  const watch = watchAdmissionClaim(fx.accessPool);
  try {
    const input = fx.draftInput();
    const key = randomUUID();
    let failed = false;
    fx.fuseki.query = async (sparql, limit) => {
      if (watch.claimed.on && !failed && sparql.includes(input.rootTarget) && sparql.includes('rv:ErasedRevision')) {
        failed = true;
        throw new WorkReadMissing('Reply root is unavailable');
      }
      return query(sparql, limit);
    };
    const first = await fx.call('POST', '/v1/member-reply-drafts', input, fx.actor, key);
    expect(first.status, JSON.stringify(first.body)).toBe(503);
    const admission = await fx.accessPool.query<{ state: string; graph_outcome: string | null }>(
      `SELECT state, graph_outcome FROM access.admission WHERE idempotency_key = $1 AND action = 'content.draft'`, [key]);
    expect(admission.rowCount).toBe(1);
    expect(admission.rows[0]!.graph_outcome).toBeNull();
    expect(admission.rows[0]!.state).not.toBe('sealed');
    const retry = await fx.call('POST', '/v1/member-reply-drafts', input, fx.actor, key);
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(retry.body.replayed).toBe(true);
  } finally {
    watch.restore();
    fx.fuseki.query = query;
    await fx.close();
  }
}, 120_000);

test('a reply identity lost inside create stays unsealed until the root is visible', async () => {
  const fx = await realmVisibilityFixture();
  const query = fx.fuseki.query.bind(fx.fuseki);
  const watch = watchAdmissionClaim(fx.accessPool);
  try {
    const input = fx.draftInput();
    const draft = await fx.call('POST', '/v1/member-reply-drafts', input);
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    watch.claimed.on = false;
    const body = {
      profile: 'realm-reply-identity-v1', reply: input.reply, variantId: input.variantId,
      revisionId: draft.body.revisionId, author: fx.actor, rootTarget: input.rootTarget,
      rootRevision: input.rootRevision, parentReply: null, parentRevision: null, contextRevision: null,
    };
    const key = randomUUID();
    let failed = false;
    fx.fuseki.query = async (sparql, limit) => {
      if (foregroundCounted() && watch.claimed.on && !failed
        && sparql.includes(input.rootTarget) && sparql.includes('rv:ErasedRevision')) {
        failed = true;
        throw new TargetUnavailable();
      }
      return query(sparql, limit);
    };
    const first = await fx.call('POST', '/v1/realm-replies', body, fx.actor, key);
    expect(first.status, JSON.stringify(first.body)).toBe(503);
    const admission = await fx.accessPool.query<{ state: string; graph_outcome: string | null }>(
      `SELECT state, graph_outcome FROM access.admission WHERE idempotency_key = $1 AND action = 'reply.create'`, [key]);
    expect(admission.rowCount).toBe(1);
    expect(admission.rows[0]!.graph_outcome).toBeNull();
    expect(admission.rows[0]!.state).not.toBe('sealed');
    const retry = await fx.call('POST', '/v1/realm-replies', body, fx.actor, key);
    expect(retry.status, JSON.stringify(retry.body)).toBe(201);
  } finally {
    watch.restore();
    fx.fuseki.query = query;
    await fx.close();
  }
}, 120_000);

test('a reply question lost after preflight seals a denial and cancels only that identity key', async () => {
  const fx = await realmVisibilityFixture();
  const query = fx.fuseki.query.bind(fx.fuseki);
  const watch = watchAdmissionClaim(fx.accessPool);
  try {
    const input = fx.draftInput();
    const draft = await fx.call('POST', '/v1/member-reply-drafts', input);
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    watch.claimed.on = false;
    const body = {
      profile: 'realm-reply-identity-v1', reply: input.reply, variantId: input.variantId,
      revisionId: draft.body.revisionId, author: fx.actor, rootTarget: input.rootTarget,
      rootRevision: input.rootRevision, parentReply: null, parentRevision: null,
      contextRevision: `https://rezics.com/id/${randomUUID()}`,
    };
    let missed = false;
    fx.fuseki.query = async (sparql, limit) => {
      if (watch.claimed.on && sparql.includes('SELECT ?context') && sparql.includes(body.contextRevision)) {
        missed = true;
        throw new WorkReadMissing('Reply question is unavailable');
      }
      return query(sparql, limit);
    };
    const key = randomUUID();
    const first = await fx.call('POST', '/v1/realm-replies', body, fx.actor, key);
    expect(missed).toBe(true);
    expect(first.status, JSON.stringify(first.body)).toBe(403);
    expect(first.body.code).toBe('realm_reply_denied');
    const admission = await fx.accessPool.query<{ id: string; state: string; graph_outcome: string }>(
      `SELECT id, state, graph_outcome FROM access.admission WHERE idempotency_key = $1 AND action = 'reply.create'`, [key]);
    expect(admission.rowCount).toBe(1);
    expect(admission.rows[0]).toMatchObject({ state: 'sealed', graph_outcome: 'cancelled' });
    const receipt = await fx.contentPool.query<{ outcome: string }>(
      'SELECT outcome FROM content.receipt WHERE operation_id = $1', [admission.rows[0]!.id]);
    expect(receipt.rows).toEqual([{ outcome: 'rejected' }]);
    expect((await fx.contentPool.query(
      'SELECT 1 FROM content.reply WHERE id = $1', [input.reply])).rowCount).toBe(0);
    // Identity creation cannot leave a publication pin on its cancelled admission.
    expect((await fx.contentPool.query(
      'SELECT 1 FROM content.publication_preparation WHERE operation_id = $1 AND pin_active',
      [admission.rows[0]!.id])).rowCount).toBe(0);
    fx.fuseki.query = query;
    const retry = await fx.call('POST', '/v1/realm-replies', body, fx.actor, key);
    expect(retry.status, JSON.stringify(retry.body)).toBe(403);
    const fresh = await fx.call('POST', '/v1/realm-replies', body);
    expect(fresh.status, JSON.stringify(fresh.body)).toBe(201);
  } finally {
    watch.restore();
    fx.fuseki.query = query;
    await fx.close();
  }
}, 120_000);

test('a revoked authority epoch retry is refused and sealed with the placement pin released', async () => {
  const fx = await realmVisibilityFixture();
  let restore = () => {};
  try {
    const body = await reviewedPlacement(fx);
    const key = randomUUID();
    restore = armSecondClaim(fx.accessPool, fx.contentPool, query => query(
      'UPDATE access.scope_gate SET authority_epoch = authority_epoch + 1 WHERE id = $1',
      [`reply:place:${fx.realm}`]).then(() => undefined));
    await expectRefusedPlacement(fx, body, key, 403);
  } finally {
    restore();
    await fx.close();
  }
}, 120_000);
