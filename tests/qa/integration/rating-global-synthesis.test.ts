import { signupPolicyFixture } from '../../../scripts/dev/signup-policy-fixture.ts';
import { provisionFixtureAuthor } from '../fixtures/authored-work.ts';
import { randomBytes, randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient, fusekiReadBudget } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry, engageAccessRecoveryFence, releaseAccessRecoveryFence }
  from '../../../services/main/src/modules/access/admission.ts';
import { GLOBAL_CONTEXT_SCOPE, GLOBAL_RATING_POPULATION_OWNER }
  from '../../../services/main/src/modules/rating/global.ts';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import { cloneQaAccountAccessDatabases } from '../support/databases.ts';
import { ratingAccount } from '../support/rating-account.ts';

const root = resolve(import.meta.dir, '../../..');
interface Opinion { observation: string; observationRevision: string; predecessor: string | null; value: number | null }
interface Component { context: string; populationOwner: string; count: number; population: number; withdrawnCount: number;
  mean: number | null; scale: { min: number; max: number }; unitMean: { numerator: string; denominator: string } | null }
interface Synthesis { status: string; missing: string[]; value: { numerator: string; denominator: string } | null;
  components: { realm: Component; global: Component }; sourcePosition: { sequence: string } }

test('RATE06: Realm and Global scores keep distinct populations and scales under an explicit synthesis policy', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL || !Bun.env.MAIN_DATA_EPOCH
    || !Bun.env.MAIN_ROUTING_EPOCH || !Bun.env.ACCOUNT_MAIN_RESOURCE || !Bun.env.ACCOUNT_SECRET) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const preparation = Date.now();
  const nonce = randomUUID().slice(0, 8);
  const state = join(root, '.temp', `rating-global-${randomUUID()}`);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const databases = await cloneQaAccountAccessDatabases(Bun.env.REZICS_QA_RUN_ID);
  const accessPool = new Pool({ connectionString: databases.urls.access, max: 5 });
  let identity: Awaited<ReturnType<typeof ratingAccount>> | undefined;
  try {
    identity = await ratingAccount({ ACCOUNT_DATABASE_URL: databases.urls.account,
      ACCOUNT_SECRET: Bun.env.ACCOUNT_SECRET, ACCOUNT_MAIN_RESOURCE: Bun.env.ACCOUNT_MAIN_RESOURCE });
    // A third private rater through the same real Account owner.
    const base = identity.issuer.replace(/\/api\/auth$/, '');
    const third = { email: `rating-c-${randomUUID()}@example.test`, password: randomBytes(24).toString('base64url') };
    const signUp = await fetch(`${base}/api/auth/sign-up/email`, { method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ ...signupPolicyFixture, name: 'c', ...third }) });
    expect(signUp.status).toBe(200);
    const thirdId = (await signUp.json() as { user: { id: string } }).user.id;
    const tokenC = await identity.tokenFor(third);
    const principals = { a: randomUUID(), b: randomUUID(), c: randomUUID() };
    await accessPool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
      VALUES ($1, $4, $5), ($2, $4, $6), ($3, $4, $7)`,
    [principals.a, principals.b, principals.c, identity.issuer, identity.a.id, identity.b.id, thirdId]);
    const persona = { a: `https://rezics.com/id/${randomUUID()}`, a2: `https://rezics.com/id/${randomUUID()}`,
      b: `https://rezics.com/id/${randomUUID()}`, c: `https://rezics.com/id/${randomUUID()}` };
    for (const actor of Object.values(persona)) {
      await accessPool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')", [actor]);
    }
    const owner = { a: principals.a, a2: principals.a, b: principals.b, c: principals.c } as const;
    async function grant(scope: string, action: string, who: keyof typeof persona = 'a') {
      await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
      await accessPool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
        VALUES ($1, $2, $3, $4, now() + interval '1 hour')`, [randomUUID(), owner[who], persona[who], action]);
      await accessPool.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1, $2, $2, $3, $4, now() + interval '1 hour')`, [randomUUID(), persona[who], scope, action]);
    }
    const fuseki = new FusekiClient(Bun.env.FUSEKI_URL, Bun.env.FUSEKI_MAINTENANCE_TOKEN, Bun.env.FUSEKI_COMMAND_TOKEN);
    const environment = { fuseki, objectDirectory: join(state, 'objects'),
      lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH } };
    const access = new AccessAdmissionRegistry(accessPool);
    await provisionFixtureAuthor(environment, persona.a);
    const main = createMainApp(fuseki, { environment, account: identity.verifier, access });
    const token = { a: identity.tokenA, a2: identity.tokenA, b: identity.tokenB, c: tokenC };
    const post = (path: string, body: object, who: keyof typeof persona = 'a', key = randomUUID(), bearer = token[who]) =>
      main.handle(new Request(`http://main.local${path}`, { method: 'POST', headers: { authorization: `Bearer ${bearer}`,
        'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(body) }));
    const read = (path: string, body: object, app = main) => app.handle(new Request(`http://main.local${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    async function success<T>(response: Response, status = 201): Promise<T> {
      const data = await response.json();
      expect({ status: response.status, error: response.status >= 400 ? data : undefined }).toEqual({ status, error: undefined });
      return data as T;
    }
    async function meteredWrite(write: () => Promise<Response>) {
      const budget = { signal: AbortSignal.timeout(10_000), callsLeft: 24, bytesLeft: 65_536 };
      const response = await fusekiReadBudget.run(budget, write);
      const cost = { calls: 24 - budget.callsLeft, bytes: 65_536 - budget.bytesLeft };
      expect(cost.calls).toBeGreaterThan(0);
      expect(cost.bytes).toBeGreaterThan(0);
      return { response, cost };
    }
    await grant('work:create:root', 'work.create');
    await grant('space:create:root', 'space.create');
    expect(Date.now() - preparation).toBeLessThan(600_000);

    const work = await success<{ work: string; mainVersion: string }>(await post('/v1/works',
      { profile: 'metadata-only-v1', authoring: 'own-work', language: 'en', title: `Global target ${nonce}`, actingSubject: persona.a }));
    const realm = (await success<{ realm: string }>(await post('/v1/spaces', { profile: 'space-realm-v1',
      name: `Global comparison Realm ${nonce}`, capabilities: ['realm'], actingSubject: persona.a }))).realm;
    await grant(`rating:context:${realm}`, 'rating.context.create');
    const realmContext = (await success<{ context: string }>(await post('/v1/rating-contexts', {
      profile: 'realm-standing-rating-context-v1', realm, question: 'Realm quality', actingSubject: persona.a }))).context;

    // Global Context: Account scope, Access grant, idempotency and its own read.
    const globalBody = { profile: 'global-rating-standing-context-v1', question: 'Global quality', actingSubject: persona.a };
    expect((await post('/v1/global-rating-contexts', globalBody, 'a', randomUUID(), identity.noScope)).status).toBe(401);
    await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [GLOBAL_CONTEXT_SCOPE]);
    expect((await post('/v1/global-rating-contexts', globalBody)).status).toBe(403);
    await grant(GLOBAL_CONTEXT_SCOPE, 'rating.context.create');
    const contextKey = randomUUID();
    const contextWrite = await meteredWrite(() => post('/v1/global-rating-contexts', globalBody, 'a', contextKey));
    const created = await success<{ context: string; populationOwner: string; scale: object; population: string }>(
      contextWrite.response);
    expect(created).toMatchObject({ populationOwner: GLOBAL_RATING_POPULATION_OWNER, scale: { min: 1, max: 5, step: 1 },
      population: 'global-account-principal', cadence: 'standing' });
    expect(await success(await post('/v1/global-rating-contexts', globalBody, 'a', contextKey), 200))
      .toMatchObject({ context: created.context, replayed: true });
    expect((await post('/v1/global-rating-contexts', { ...globalBody, question: 'Other question' }, 'a', contextKey)).status).toBe(409);
    for (const extra of [{ realm }, { scale: 10 }, { populationOwner: realm }]) {
      expect([400, 422]).toContain((await post('/v1/global-rating-contexts', { ...globalBody, ...extra })).status);
    }
    const globalContext = created.context;
    const globalId = globalContext.split('/').at(-1)!;
    expect(await success(await main.handle(new Request(`http://main.local/v1/global-rating-contexts/${globalId}`)), 200))
      .toMatchObject({ context: globalContext, question: 'Global quality', scale: { max: 5 } });
    // Realm reads never select a Global Context, and the Global read never selects a Realm Context.
    expect((await main.handle(new Request(`http://main.local/v1/rating-contexts/${globalId}`))).status).toBe(404);
    expect((await main.handle(new Request(`http://main.local/v1/global-rating-contexts/${realmContext.split('/').at(-1)}`))).status).toBe(404);
    const graph = await fuseki.query(`PREFIX rv: <${RV}> SELECT ?type ?realm WHERE { GRAPH ${iri(GRAPHS.current)} {
      ${iri(globalContext)} a ?type . OPTIONAL { ${iri(globalContext)} rv:realm ?realm } } }`);
    expect(graph.results?.bindings.map(row => row.type!.value)).toEqual([`${RV}GlobalRatingContext`]);
    expect(graph.results?.bindings[0]?.realm).toBeUndefined();
    const inventory = await accessPool.query('SELECT realm FROM access.rating_aggregate_context WHERE context = $1', [globalContext]);
    expect(inventory.rows).toEqual([{ realm: GLOBAL_RATING_POPULATION_OWNER }]);

    for (const who of ['a', 'a2', 'b', 'c'] as const) {
      await grant(`rating:observe:${globalContext}`, 'rating.observation.set', who);
      if (who !== 'a2') await grant(`rating:observe:${realmContext}`, 'rating.observation.set', who);
    }
    const realmSet = (who: keyof typeof persona, value: number | null, head: string | null = null, key = randomUUID()) =>
      post('/v1/rating-observations', { profile: 'realm-standing-rating-observation-v1', context: realmContext,
        work: work.work, mainVersion: work.mainVersion, value, expectedRevisionHead: head, actingSubject: persona[who] }, who, key);
    const globalSet = (who: keyof typeof persona, value: number | null, head: string | null = null, key = randomUUID(),
      context = globalContext) => post('/v1/global-rating-observations', { profile: 'global-rating-standing-observation-v1',
      context, work: work.work, mainVersion: work.mainVersion, value, expectedRevisionHead: head, actingSubject: persona[who] }, who, key);
    await success<Opinion>(await realmSet('a', 8));
    await success<Opinion>(await realmSet('b', 6));

    // Scale, cross-kind and authority denials write nothing.
    expect([400, 422]).toContain((await globalSet('a', 8)).status);
    expect(await (await globalSet('a', 5, null, randomUUID(), realmContext)).json())
      .toMatchObject({ code: 'rating_observation_unavailable' });
    expect((await post('/v1/rating-observations', { profile: 'realm-standing-rating-observation-v1', context: globalContext,
      work: work.work, mainVersion: work.mainVersion, value: 5, expectedRevisionHead: null, actingSubject: persona.a })).status)
      .toBe(409);
    expect([400, 422]).toContain((await post('/v1/global-rating-observations', {}, 'a')).status);
    const aKey = randomUUID();
    const firstWrite = await meteredWrite(() => globalSet('a', 5, null, aKey));
    const a = await success<Opinion>(firstWrite.response);
    expect(await success<Opinion & { replayed: boolean }>(await globalSet('a', 5, null, aKey), 200))
      .toMatchObject({ ...a, replayed: true });
    expect((await globalSet('a', 4, null, aKey)).status).toBe(409);
    // Another persona of the same private principal cannot add a second Global opinion.
    expect(await (await globalSet('a2', 1)).json()).toMatchObject({ code: 'stale_head' });
    const b = await success<Opinion>(await globalSet('b', 3));
    // Concurrent first writes by one principal: one winner, one terminal stale loser.
    const race = await Promise.all([globalSet('c', 4), globalSet('c', 4)]);
    expect(race.map(response => response.status).sort()).toEqual([201, 409]);
    await accessPool.query('UPDATE access.principal SET active = false WHERE id = $1', [principals.b]);
    expect((await globalSet('b', 2, b.observationRevision)).status).toBe(403);
    await accessPool.query('UPDATE access.principal SET active = true WHERE id = $1', [principals.b]);

    const baselineWrite = await meteredWrite(() => globalSet('a', 5, a.observationRevision));
    const currentA = await success<Opinion>(baselineWrite.response);

    const synthesisBody = { profile: 'realm-global-standing-synthesis-v1', realmContext, globalContext,
      work: work.work, mainVersion: work.mainVersion };
    let calls = 0, sql = 0, graphBytes = 0;
    const measuredPool = { connect: async () => {
      const client = await accessPool.connect();
      return { query: (...args: Parameters<typeof client.query>) => { sql++; return client.query(...args); },
        release: (destroy?: boolean) => client.release(destroy) };
    } } as unknown as Pool;
    const reader = createMainApp(fuseki, { environment, account: identity.verifier,
      access: new AccessAdmissionRegistry(measuredPool) });
    async function synthesize(expected = 200): Promise<Synthesis> {
      const budget = { signal: AbortSignal.timeout(10_000), callsLeft: 8, bytesLeft: 4_194_304 };
      sql = 0;
      const response = await fusekiReadBudget.run(budget, () => read('/v1/rating-syntheses', synthesisBody, reader));
      calls = 8 - budget.callsLeft; graphBytes = 4_194_304 - budget.bytesLeft;
      return success<Synthesis>(response, expected);
    }
    const result = await synthesize();
    expect(result).toMatchObject({ status: 'complete', missing: [], value: { numerator: '17', denominator: '24' },
      components: {
        realm: { context: realmContext, populationOwner: realm, population: 2, count: 2, mean: 7,
          scale: { min: 1, max: 10 }, unitMean: { numerator: '2', denominator: '3' } },
        global: { context: globalContext, populationOwner: GLOBAL_RATING_POPULATION_OWNER, population: 3, count: 3,
          mean: 4, scale: { min: 1, max: 5 }, unitMean: { numerator: '3', denominator: '4' } } } });
    expect(JSON.stringify(result)).not.toContain('5.2');
    // Cost contract: one graph query, two four-statement owner snapshots and one fence check.
    expect({ calls, sql }).toEqual({ calls: 1, sql: 9 });
    expect(graphBytes).toBeLessThan(1_048_576);
    const baseline = graphBytes;

    // Withdrawal removes only that rater; restoration needs the withdrawn head.
    const withdrawn = await success<Opinion>(await globalSet('b', null, b.observationRevision));
    expect((await synthesize()).components.global).toMatchObject({ population: 3, count: 2, withdrawnCount: 1, mean: 4.5 });
    expect((await globalSet('b', 3, b.observationRevision)).status).toBe(409);
    await success<Opinion>(await globalSet('b', 3, withdrawn.observationRevision));
    expect((await synthesize()).value).toEqual({ numerator: '17', denominator: '24' });

    // Unrelated Contexts, MainVersions and history do not change the work.
    const other = await success<{ work: string; mainVersion: string }>(await post('/v1/works',
      { profile: 'metadata-only-v1', authoring: 'own-work', language: 'en', title: `Unrelated ${nonce}`, actingSubject: persona.a }));
    for (const who of ['a', 'b', 'c'] as const) {
      await success(await post('/v1/global-rating-observations', { profile: 'global-rating-standing-observation-v1',
        context: globalContext, work: other.work, mainVersion: other.mainVersion, value: 1, expectedRevisionHead: null,
        actingSubject: persona[who] }, who));
    }
    const grownWrite = await meteredWrite(() => globalSet('a', 5, currentA.observationRevision));
    await success<Opinion>(grownWrite.response);
    expect(grownWrite.cost.calls).toBe(baselineWrite.cost.calls);
    expect(Math.abs(grownWrite.cost.bytes - baselineWrite.cost.bytes)).toBeLessThan(1024);
    const again = await synthesize();
    expect(again.value).toEqual({ numerator: '17', denominator: '24' });
    expect({ calls, sql }).toEqual({ calls: 1, sql: 9 });
    expect(Math.abs(graphBytes - baseline)).toBeLessThan(256);

    // A Global Context with nobody available is partial, not the Realm score.
    const emptyGlobal = (await success<{ context: string }>(await post('/v1/global-rating-contexts',
      { ...globalBody, question: 'Unrated global question' }))).context;
    expect(await success(await read('/v1/rating-syntheses', { ...synthesisBody, globalContext: emptyGlobal }), 200))
      .toMatchObject({ status: 'partial', missing: ['global'], value: null, numericValue: null,
        components: { realm: { mean: 7 }, global: { population: 0, mean: null } } });
    expect(await success(await read('/v1/global-rating-aggregates', { profile: 'global-rating-standing-latest-mean-v1',
      context: globalContext, work: work.work, mainVersion: work.mainVersion }), 200))
      .toMatchObject({ complete: true, count: 3, mean: 4, histogram: [0, 0, 1, 1, 1] });
    // Swapped kinds are rejected; the Realm aggregate cannot read the Global population.
    expect((await read('/v1/rating-syntheses', { ...synthesisBody, realmContext: globalContext, globalContext: realmContext })).status).toBe(400);
    expect((await read('/v1/rating-aggregates', { profile: 'realm-standing-latest-mean-v1', context: globalContext,
      work: work.work, mainVersion: work.mainVersion })).status).toBe(503);

    // Recovery: a closed Access fence or lost manifest bytes are unavailable, never a smaller population.
    const generation = await engageAccessRecoveryFence(accessPool);
    expect((await read('/v1/rating-syntheses', synthesisBody)).status).toBe(503);
    await releaseAccessRecoveryFence(accessPool, generation);
    const objects = join(state, 'objects'), saved = join(state, 'saved-objects');
    cpSync(objects, saved, { recursive: true });
    rmSync(objects, { recursive: true, force: true });
    expect((await read('/v1/rating-syntheses', synthesisBody)).status).toBe(503);
    cpSync(saved, objects, { recursive: true });
    expect((await synthesize()).value).toEqual({ numerator: '17', denominator: '24' });

    // Public graph records keep no private counting identity.
    const leaked = await fuseki.query(`ASK { GRAPH ?g { ?s ?p ?o FILTER(CONTAINS(STR(?o), "${principals.a}")
      || CONTAINS(STR(?o), "${principals.c}")) } }`);
    expect(leaked.boolean).toBe(false);
    expect(a.observation).not.toBe(b.observation);
  } finally {
    await identity?.close();
    await accessPool.end();
    await databases.close();
    rmSync(state, { recursive: true, force: true });
  }
}, 240_000);
