import { expect } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { createMainApp, type MainWorkDependencies } from '../../../services/main/src/app.ts';
import { fusekiReadBudget } from '../../../services/main/src/infrastructure/fuseki.ts';
import { RATING_INVENTORY_SQL, readRatingAggregateInventory } from '../../../services/main/src/modules/access/rating-aggregate-inventory.ts';
import { EXPERIENCE_CONTEXT_ID, EXPERIENCE_OBSERVATION_ID } from '../../../services/main/src/modules/rating/experience.ts';
import { EXPERIENCE_AGGREGATE_PROFILES, type ExperienceAggregateProfile } from '../../../services/main/src/modules/rating/experience-reduction.ts';
import { EXPERIENCE_CONTEXT_DEFAULT_PROFILE } from '../../../services/main/src/modules/rating/experience-aggregate.ts';
import { DATASET, GRAPHS, ID, RV, iri, type WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';
import { accessStateCoverage } from '../../../services/main/src/modules/work/access-recovery-coverage.ts';
import { ratingAggregateBackground } from './rating-aggregate-background.ts';

interface Opinion { observation: string; observationRevision: string; context: string; value: number | null;
  sourcePosition: { sequence: string }; replayed: boolean }
interface Result { profile: string; aggregationPolicy: string; count: number; mean: number | null;
  policyRevision: string;
  precision: { kind: string; numerator?: string; denominator?: string };
  population: { observations: number; raters: number; availableObservations: number; withdrawnObservations: number; contributingRaters: number };
  distribution: { unit: string; points: { numerator: string; denominator: string; count: number }[] };
  sourcePosition: { datasetId: string; dataEpoch: string; sequence: string } }
interface Fixture {
  env: WorkActivationEnvironment; accessPool: Pool; access: MainWorkDependencies['access'];
  account: MainWorkDependencies['account']; realm: string; work: { work: string; mainVersion: string };
  principalA: string; principalB: string; personaA: string; personaB: string; other: string; tokenA: string; tokenB: string;
  post(path: string, body: object, key?: string, token?: string): Promise<Response>;
  success<T>(response: Response, status?: number): Promise<T>;
  grant(scope: string, action: string, actor?: string, principal?: string): Promise<void>;
  serverTime(instant: string): Promise<void>;
}

/** Extends the existing two-owner graph-loss fixture; no duplicate stack setup. */
export async function exerciseRatingAggregates(f: Fixture) {
  const { env, accessPool, realm, personaA, personaB, other } = f;
  const work = { work: f.work.work, mainVersion: f.work.mainVersion };
  const api = createMainApp(env.fuseki, { environment: env, access: f.access, account: f.account });
  const post = f.post, success = f.success;
  const created = await success<{ context: string; contextRevision: string; policyRevision: string }>(
    await post('/v1/rating-contexts', {
      profile: EXPERIENCE_CONTEXT_ID, realm, question: 'Aggregate experience quality', actingSubject: personaA }));
  const context = created.context;
  expect(created.policyRevision).toBe(created.contextRevision);
  for (const [actor, principal] of [[personaA, f.principalA], [personaB, f.principalA], [other, f.principalB]]) {
    await f.grant(`rating:observe:${context}`, 'rating.observation.set', actor, principal);
    await f.grant(`rating:read:${context}`, 'rating.observation.read', actor, principal);
  }
  await f.grant(`rating:policy:${context}`, 'rating.context.policy.set');
  const sqlMeter = new AsyncLocalStorage<{ calls: number }>();
  const metered = new WeakSet<PoolClient>();
  accessPool.on('acquire', client => {
    if (metered.has(client)) return;
    metered.add(client);
    const query = client.query;
    client.query = function (...args: unknown[]) {
      const meter = sqlMeter.getStore();
      if (meter) meter.calls++;
      return Reflect.apply(query, this, args);
    } as typeof client.query;
  });
  const costs: { branch: string; calls: number; sqlCalls: number; responseBytes: number; elapsedMs: number }[] = [];
  const graph = env.fuseki;
  async function aggregate(profile: ExperienceAggregateProfile | typeof EXPERIENCE_CONTEXT_DEFAULT_PROFILE,
    target = { context, ...work }, app = api) {
    return app.handle(new Request('http://main.local/v1/rating-aggregates', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile, ...target }) }));
  }
  async function all(branch: string, expected: (number | null)[], target = { context, ...work }, app = api) {
    const results: Result[] = [];
    for (const [i, profile] of EXPERIENCE_AGGREGATE_PROFILES.entries()) {
      const budget = { signal: AbortSignal.timeout(10_000), callsLeft: 1, bytesLeft: 1_048_576 };
      const start = Date.now();
      const sql = { calls: 0 };
      const result = await sqlMeter.run(sql, () => fusekiReadBudget.run(budget, async () => {
        const response = await aggregate(profile, target, app);
        if (response.status !== 200) throw new Error(`${branch}/${profile}: ${response.status} ${await response.text()}`);
        return success<Result>(response, 200);
      }));
      costs.push({ branch: `${branch}:${i}`, calls: 1 - budget.callsLeft, sqlCalls: sql.calls, responseBytes: 1_048_576 - budget.bytesLeft,
        elapsedMs: Date.now() - start });
      expect(result.profile).toBe(profile); expect(result.mean).toBe(expected[i]!);
      expect(costs.at(-1)!.calls).toBe(1); expect(costs.at(-1)!.responseBytes).toBeGreaterThan(0);
      expect(costs.at(-1)!.sqlCalls).toBe(5);
      results.push(result);
    }
    return results;
  }
  expect((await all('empty', [null, null, null]))[0]).toMatchObject({
    count: 0, precision: { kind: 'no-data' }, population: { observations: 0, raters: 0 } });
  const markers = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const initialKeys = [randomUUID(), randomUUID(), randomUUID()];
  const body = (value: number | null, marker: string, expectedRevisionHead: string | null = null, actor = personaA,
    target = { context, ...work }) => ({ profile: EXPERIENCE_OBSERVATION_ID, ...target,
      value, occasion: marker, expectedRevisionHead, actingSubject: actor });
  const submit = (value: number | null, marker: string, head: string | null = null, actor = personaA,
    key = randomUUID(), token?: string) => post('/v1/rating-observations', body(value, marker, head, actor), key, token);
  const initial: Opinion[] = [];
  for (let i = 0; i < 3; i++) {
    await f.serverTime(`2026-11-04T09:00:0${i}.000Z`);
    initial.push(await success<Opinion>(await submit([2, 2, 8][i]!, markers[i]!, null, i === 1 ? personaB : personaA, initialKeys[i]!)));
  }
  initial.push(await success<Opinion>(await submit(6, markers[3]!, null, other, randomUUID(), f.tokenB)));
  const baseline = await all('2-2-8-and-6', [7, 5, 4.5]);
  const initialDefault = await success<Result>(await aggregate(EXPERIENCE_CONTEXT_DEFAULT_PROFILE), 200);
  expect(initialDefault).toMatchObject({ mean: 7, aggregationPolicy: 'latest-per-rater-mean',
    policyRevision: created.contextRevision, denominatorUnit: 'rater' });
  const policyPath = `/v1/rating-contexts/${context.split('/').at(-1)}/policy-revisions`;
  const policyBody = (expectedPolicyHead: string, aggregationPolicy: 'latest-per-rater-mean' | 'mean-per-rater' | 'pooled-observation-mean',
    actingSubject = personaA) => ({ profile: 'rating-aggregate-default-policy-v1',
    expectedPolicyHead, aggregationPolicy, actingSubject });
  const noGrant = await post(policyPath, policyBody(created.contextRevision, 'mean-per-rater', other), randomUUID(), f.tokenB);
  expect(noGrant.status).toBe(403);
  await f.grant(`rating:policy:${context}`, 'rating.context.policy.set', other, f.principalB);
  await accessPool.query('UPDATE access.principal SET active = false WHERE id = $1', [f.principalB]);
  expect((await post(policyPath, policyBody(created.contextRevision, 'mean-per-rater', other), randomUUID(), f.tokenB)).status).toBe(403);
  await accessPool.query('UPDATE access.principal SET active = true WHERE id = $1', [f.principalB]);
  const policyKey = randomUUID();
  const command = graph.command.bind(graph);
  graph.command = async envelope => {
    await command(envelope);
    graph.command = command;
    throw new Error('fixture: policy command response lost after commit');
  };
  let changed: { policyRevision: string; predecessor: string; replayed: boolean };
  try {
    changed = await success(await post(policyPath, policyBody(created.contextRevision, 'mean-per-rater'), policyKey));
  } finally { graph.command = command; }
  expect(changed).toMatchObject({ predecessor: created.contextRevision, replayed: false });
  expect((await success<Result>(await aggregate(EXPERIENCE_CONTEXT_DEFAULT_PROFILE), 200))
    .mean).toBe(5);
  expect(await success(await post(policyPath, policyBody(created.contextRevision, 'mean-per-rater'), policyKey), 200))
    .toMatchObject({ policyRevision: changed.policyRevision, replayed: true });
  expect((await post(policyPath, policyBody(created.contextRevision, 'pooled-observation-mean'), policyKey)).status).toBe(409);
  expect((await post(policyPath, policyBody(created.contextRevision, 'pooled-observation-mean'))).status).toBe(409);
  const exact = async (revision: string) => api.handle(new Request(`http://main.local${policyPath}/${revision.split('/').at(-1)}?actingSubject=${encodeURIComponent(personaA)}`,
    { headers: { authorization: `Bearer ${f.tokenA}` } }));
  expect(await success(await exact(created.contextRevision), 200)).toMatchObject({
    policyRevision: created.contextRevision, predecessor: null,
    aggregationPolicy: 'latest-per-rater-mean', basis: { question: 'Aggregate experience quality' } });
  expect(await success(await exact(changed.policyRevision), 200)).toMatchObject({
    policyRevision: changed.policyRevision, predecessor: created.contextRevision,
    aggregationPolicy: 'mean-per-rater', basis: { question: 'Aggregate experience quality' } });
  const policyManifest = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?manifest WHERE {
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(changed.policyRevision)} rv:manifest ?manifest } }`))
    .results!.bindings![0]!.manifest!.value;
  await env.fuseki.update(`PREFIX rv: <${RV}> DELETE DATA { GRAPH ${iri(GRAPHS.revisions)} {
    ${iri(changed.policyRevision)} rv:manifest ${iri(policyManifest)} . } }`);
  expect((await aggregate(EXPERIENCE_CONTEXT_DEFAULT_PROFILE)).status).toBe(503);
  await env.fuseki.update(`PREFIX rv: <${RV}> INSERT DATA { GRAPH ${iri(GRAPHS.revisions)} {
    ${iri(changed.policyRevision)} rv:manifest ${iri(policyManifest)} . } }`);
  await env.fuseki.update(`PREFIX rv: <${RV}> WITH ${iri(GRAPHS.current)}
    DELETE { ${iri(context)} rv:ratingPolicyHead ${iri(changed.policyRevision)} }
    INSERT { ${iri(context)} rv:ratingPolicyHead ${iri(created.contextRevision)} } WHERE {}`);
  expect((await aggregate(EXPERIENCE_CONTEXT_DEFAULT_PROFILE)).status).toBe(503);
  await env.fuseki.update(`PREFIX rv: <${RV}> WITH ${iri(GRAPHS.current)}
    DELETE { ${iri(context)} rv:ratingPolicyHead ${iri(created.contextRevision)} }
    INSERT { ${iri(context)} rv:ratingPolicyHead ${iri(changed.policyRevision)} } WHERE {}`);
  const contenders = await Promise.all([
    post(policyPath, policyBody(changed.policyRevision, 'latest-per-rater-mean')),
    post(policyPath, policyBody(changed.policyRevision, 'pooled-observation-mean')),
  ]);
  expect(contenders.map(result => result.status).sort()).toEqual([201, 409]);
  const winner = await contenders.find(result => result.status === 201)!.json() as { policyRevision: string };
  changed = await success(await post(policyPath, policyBody(winner.policyRevision, 'mean-per-rater')));
  expect((await success<Result>(await aggregate(EXPERIENCE_CONTEXT_DEFAULT_PROFILE), 200)).mean).toBe(5);
  const defaultCost = { signal: AbortSignal.timeout(10_000), callsLeft: 1, bytesLeft: 1_048_576 };
  const defaultSql = { calls: 0 };
  await sqlMeter.run(defaultSql, () => fusekiReadBudget.run(defaultCost,
    () => aggregate(EXPERIENCE_CONTEXT_DEFAULT_PROFILE)));
  expect(defaultCost.callsLeft).toBe(0);
  expect(defaultSql.calls).toBe(5);
  expect(baseline.map(result => result.count)).toEqual([2, 2, 4]);
  expect(baseline.map(result => result.precision)).toEqual([
    { kind: 'exact-rational', numerator: '7', denominator: '1' },
    { kind: 'exact-rational', numerator: '5', denominator: '1' },
    { kind: 'exact-rational', numerator: '9', denominator: '2' }]);
  expect(baseline.map(result => result.distribution.points)).toEqual([
    [{ numerator: '6', denominator: '1', count: 1 }, { numerator: '8', denominator: '1', count: 1 }],
    [{ numerator: '4', denominator: '1', count: 1 }, { numerator: '6', denominator: '1', count: 1 }],
    [{ numerator: '2', denominator: '1', count: 2 }, { numerator: '6', denominator: '1', count: 1 }, { numerator: '8', denominator: '1', count: 1 }],
  ]);
  for (const result of baseline) expect(result.population).toEqual({ observations: 4, raters: 2,
    availableObservations: 4, withdrawnObservations: 0, contributingRaters: 2 });
  const secretData = JSON.stringify(baseline);
  for (const secret of [f.principalA, f.principalB, personaA, personaB, other, ...markers]) expect(secretData).not.toContain(secret);

  await f.serverTime('2026-11-04T12:00:00.000Z');
  const corrected = await success<Opinion>(await submit(4, markers[0]!, initial[0]!.observationRevision, personaB));
  await all('older-correction', [7, 16 / 3, 5]);
  const withdrawn = await success<Opinion>(await submit(null, markers[2]!, initial[2]!.observationRevision));
  expect((await all('withdraw-latest', [6, 4.5, 4]))[0]!.population.contributingRaters).toBe(1);
  const restored = await success<Opinion>(await submit(8, markers[2]!, withdrawn.observationRevision));
  await all('restore-latest', [7, 16 / 3, 5]);
  // Failed sealing must roll back both the admission and the private inventory.
  await accessPool.query(`CREATE FUNCTION access.fail_rating_inventory_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'fixture inventory failure'; END $$;
    CREATE TRIGGER fail_rating_inventory_fixture BEFORE INSERT ON access.outbox
    FOR EACH ROW WHEN (NEW.kind = 'admission.sealed') EXECUTE FUNCTION access.fail_rating_inventory_fixture()`);
  const pendingMarker = randomUUID(), pendingKey = randomUUID();
  const pending = await submit(10, pendingMarker, null, personaA, pendingKey);
  expect(pending.status).toBe(202);
  const admission = (await accessPool.query(`SELECT id, state FROM access.admission
    WHERE principal_id = $1 AND action = 'rating.observation.set' AND idempotency_key = $2`, [f.principalA, pendingKey])).rows[0]!;
  expect(admission.state).toBe('claimed');
  expect((await accessPool.query('SELECT 1 FROM access.rating_aggregate_head WHERE admission_id = $1', [admission.id])).rowCount).toBe(0);
  expect((await accessPool.query("SELECT 1 FROM access.outbox WHERE admission_id = $1 AND kind = 'admission.sealed'", [admission.id])).rowCount).toBe(0);
  expect((await aggregate(EXPERIENCE_AGGREGATE_PROFILES[0])).status).toBe(503);
  await accessPool.query('DROP TRIGGER fail_rating_inventory_fixture ON access.outbox; DROP FUNCTION access.fail_rating_inventory_fixture()');
  const extra = await success<Opinion>(await submit(10, pendingMarker, null, personaA, pendingKey), 200);
  const beforeRetry = await all('new-experience', [8, 6, 6]);
  expect(await success<Opinion>(await submit(10, pendingMarker, null, personaA, pendingKey), 200)).toEqual(extra);
  expect(await all('retry', [8, 6, 6])).toEqual(beforeRetry);
  // Equal trusted evaluation instants use the server Observation IRI, even after correction.
  const tiedMarker = randomUUID();
  const tied = await success<Opinion>(await submit(9, tiedMarker));
  const priorInventoryHead = (await accessPool.query('SELECT * FROM access.rating_aggregate_head WHERE observation = $1', [tied.observation])).rows[0]!;
  expect(tied.observation > extra.observation).toBe(true);
  await all('tie', [7.5, 6.3, 6.5]);
  const tiedWithdrawn = await success<Opinion>(await submit(null, tiedMarker, tied.observationRevision));
  await all('tie-withdrawn', [6, 6, 6]);
  const tiedRestored = await success<Opinion>(await submit(9, tiedMarker, tiedWithdrawn.observationRevision));
  const finalMeans = [7.5, 6.3, 6.5];
  await all('tie-restored', finalMeans);
  expect(await success<Opinion>(await submit(2, markers[0]!, null, personaA, initialKeys[0]!), 200))
    .toMatchObject({ ...initial[0], replayed: true });
  await all('old-seal-retry', finalMeans);
  // Exact private historical bytes survive every aggregate request.
  const exactUrl = `http://main.local/v1/rating-observations/${initial[0]!.observation.split('/').at(-1)}/revisions/${initial[0]!.observationRevision.split('/').at(-1)}?${new URLSearchParams({
    profile: EXPERIENCE_OBSERVATION_ID, context, mainVersion: work.mainVersion, actingSubject: personaA })}`;
  expect((await api.handle(new Request(exactUrl))).status).toBe(401);
  expect(await success(await api.handle(new Request(exactUrl, { headers: { authorization: `Bearer ${f.tokenA}` } })), 200))
    .toMatchObject({ value: 2, occasion: markers[0], evaluatedAt: '2026-11-04T09:00:00.000Z' });

  // Independent Context, Realm and target populations remain separate.
  const otherCreated = await success<{ work: string; mainVersion: string }>(await post('/v1/works', {
    profile: 'metadata-only-v1', title: 'Other Rating target', actingSubject: personaA }));
  const otherWork = { work: otherCreated.work, mainVersion: otherCreated.mainVersion };
  await success(await post('/v1/rating-observations', body(1, randomUUID(), null, personaA, { context, ...otherWork })));
  expect((await all('other-target', [1, 1, 1], { context, ...otherWork }))[0]!.population.observations).toBe(1);
  const otherRealm = (await success<{ realm: string }>(await post('/v1/spaces', {
    profile: 'space-realm-v1', name: 'Other Rating Realm', capabilities: ['realm'], actingSubject: personaA }))).realm;
  await f.grant(`rating:context:${otherRealm}`, 'rating.context.create');
  for (const selectedRealm of [realm, otherRealm]) {
    const c = (await success<{ context: string }>(await post('/v1/rating-contexts', {
      profile: EXPERIENCE_CONTEXT_ID, realm: selectedRealm, question: 'A separate question', actingSubject: personaA }))).context;
    await f.grant(`rating:observe:${c}`, 'rating.observation.set');
    const marker = markers[0]!;
    const opinion = await success<Opinion>(await post('/v1/rating-observations', body(3, marker, null, personaA, { context: c, ...work })));
    expect(opinion.observation).not.toBe(initial[0]!.observation);
    await all('other-context', [3, 3, 3], { context: c, ...work });
    if (selectedRealm === otherRealm) {
      await success(await post('/v1/rating-observations', body(null, marker, opinion.observationRevision, personaA, { context: c, ...work })));
      expect((await all('all-withdrawn', [null, null, null], { context: c, ...work }))[0])
        .toMatchObject({ count: 0, precision: { kind: 'no-data' }, population: { observations: 1, raters: 1, withdrawnObservations: 1 } });
    }
  }
  await all('population-isolation', finalMeans);
  expect((await aggregate(EXPERIENCE_AGGREGATE_PROFILES[0], { context, work: otherWork.work, mainVersion: work.mainVersion })).status).toBe(503);

  // Lost or stale graph slots cannot become a complete smaller population.
  const head = tiedRestored.observationRevision;
  const remove = `${iri(tied.observation)} rv:ratingContext ${iri(context)} .`;
  await graph.update(`PREFIX rv: <${RV}> DELETE DATA { GRAPH ${iri(GRAPHS.current)} { ${remove} } }`);
  expect((await aggregate(EXPERIENCE_AGGREGATE_PROFILES[0])).status).toBe(503);
  await graph.update(`PREFIX rv: <${RV}> INSERT DATA { GRAPH ${iri(GRAPHS.current)} { ${remove} } }`);
  await graph.update(`PREFIX rv: <${RV}> WITH ${iri(GRAPHS.current)}
    DELETE { ${iri(tied.observation)} rv:observationHead ${iri(head)} }
    INSERT { ${iri(tied.observation)} rv:observationHead ${iri(tied.observationRevision)} } WHERE {}`);
  expect((await aggregate(EXPERIENCE_AGGREGATE_PROFILES[0])).status).toBe(503);
  await graph.update(`PREFIX rv: <${RV}> WITH ${iri(GRAPHS.current)}
    DELETE { ${iri(tied.observation)} rv:observationHead ${iri(tied.observationRevision)} }
    INSERT { ${iri(tied.observation)} rv:observationHead ${iri(head)} } WHERE {}`);
  const manifest = (await graph.query(`PREFIX rv: <${RV}> SELECT ?m WHERE {
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(head)} rv:manifest ?m } }`)).results!.bindings![0]!.m!.value;
  const file = join(env.objectDirectory, manifest.slice(-64));
  const bytes = readFileSync(file);
  renameSync(file, `${file}.held`);
  expect((await aggregate(EXPERIENCE_AGGREGATE_PROFILES[0])).status).toBe(503);
  renameSync(`${file}.held`, file);
  writeFileSync(file, 'invalid');
  expect((await aggregate(EXPERIENCE_AGGREGATE_PROFILES[0])).status).toBe(503);
  writeFileSync(file, Buffer.alloc(524_289));
  expect((await aggregate(EXPERIENCE_AGGREGATE_PROFILES[0])).status).toBe(422);
  writeFileSync(file, bytes);
  // Reverse faults: graph is current, while the independent private owner loses
  // or rolls back one head. Neither direction may silently shrink the population.
  const inventoryCoverage = { before: await accessStateCoverage(accessPool),
    missing: { count: '', digest: '' }, rolledBack: { count: '', digest: '' }, restored: { count: '', digest: '' } };
  const removed = (await accessPool.query('DELETE FROM access.rating_aggregate_head WHERE observation = $1 RETURNING *', [tied.observation])).rows[0]!;
  expect((await aggregate(EXPERIENCE_AGGREGATE_PROFILES[0])).status).toBe(503);
  inventoryCoverage.missing = await accessStateCoverage(accessPool);
  expect(inventoryCoverage.missing.digest).not.toBe(inventoryCoverage.before.digest);
  expect(BigInt(inventoryCoverage.missing.count)).toBe(BigInt(inventoryCoverage.before.count) - 1n);
  await accessPool.query('INSERT INTO access.rating_aggregate_head SELECT (jsonb_populate_record(NULL::access.rating_aggregate_head, $1::jsonb)).*', [JSON.stringify(removed)]);
  await accessPool.query('UPDATE access.rating_aggregate_head SET revision = $2, admission_id = $3 WHERE observation = $1',
    [tied.observation, priorInventoryHead.revision, priorInventoryHead.admission_id]);
  expect((await aggregate(EXPERIENCE_AGGREGATE_PROFILES[0])).status).toBe(503);
  inventoryCoverage.rolledBack = await accessStateCoverage(accessPool);
  expect(inventoryCoverage.rolledBack.count).toBe(inventoryCoverage.before.count);
  expect(inventoryCoverage.rolledBack.digest).not.toBe(inventoryCoverage.before.digest);
  await accessPool.query('UPDATE access.rating_aggregate_head SET revision = $2, admission_id = $3 WHERE observation = $1',
    [tied.observation, removed.revision, removed.admission_id]);
  inventoryCoverage.restored = await accessStateCoverage(accessPool);
  expect(inventoryCoverage.restored).toEqual(inventoryCoverage.before);
  await all('private-inventory-restored', finalMeans);
  await accessPool.query('UPDATE access.rating_aggregate_head SET principal_id = $2 WHERE observation = $1', [tied.observation, f.principalB]);
  expect((await aggregate(EXPERIENCE_AGGREGATE_PROFILES[0])).status).toBe(503);
  await accessPool.query('UPDATE access.rating_aggregate_head SET principal_id = $2 WHERE observation = $1', [tied.observation, f.principalA]);
  for (const limit of [{ callsLeft: 0, bytesLeft: 1_048_576 }, { callsLeft: 1, bytesLeft: 1 }]) {
    expect((await fusekiReadBudget.run({ ...limit, signal: AbortSignal.timeout(10_000) },
      () => aggregate(EXPERIENCE_AGGREGATE_PROFILES[0]))).status).toBe(422);
  }
  await graph.update(`PREFIX rv: <${RV}> INSERT DATA { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }`);
  expect((await aggregate(EXPERIENCE_AGGREGATE_PROFILES[0])).status).toBe(503);
  expect((await post(policyPath, policyBody(changed.policyRevision, 'pooled-observation-mean'))).status).toBe(503);
  await graph.update(`PREFIX rv: <${RV}> DELETE DATA { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }`);
  // No inventory is a migration boundary, including for an otherwise intact Context.
  const legacy = (await success<{ context: string }>(await post('/v1/rating-contexts', {
    profile: EXPERIENCE_CONTEXT_ID, realm, question: 'Legacy inventory boundary', actingSubject: personaA }))).context;
  await accessPool.query('DELETE FROM access.rating_aggregate_context WHERE context = $1', [legacy]);
  expect((await aggregate(EXPERIENCE_AGGREGATE_PROFILES[0], { context: legacy, ...work })).status).toBe(503);

  // Deadline covers queueing and a real blocked SELECT, and the pool remains usable.
  const deadlinePool = new Pool({ connectionString: accessPool.options.connectionString, max: 1 });
  try {
    const held = await deadlinePool.connect();
    try {
      const started = Date.now();
      await expect(readRatingAggregateInventory(deadlinePool, context, work.mainVersion, AbortSignal.timeout(50))).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(2000);
    } finally { held.release(); }
    const blocker = await accessPool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE access.rating_aggregate_head IN ACCESS EXCLUSIVE MODE');
      const blockedAt = Date.now();
      await expect(readRatingAggregateInventory(deadlinePool, context, work.mainVersion, AbortSignal.timeout(100))).rejects.toThrow();
      expect(Date.now() - blockedAt).toBeLessThan(2000);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); }
    expect((await readRatingAggregateInventory(deadlinePool, context, work.mainVersion)).heads).toHaveLength(6);
  } finally { await deadlinePool.end(); }

  const plans: unknown[] = [];
  const unrelated = await ratingAggregateBackground(env, accessPool, { context, ...otherWork }, corrected.observation, 256);
  // Background is bulk-built once, then admitted at geometric prefixes.
  const background = Array.from({ length: 256 }, () => ({ observation: ID + randomUUID(), revision: ID + randomUUID(),
    context: ID + randomUUID(), slot: `urn:rezics:rating-slot:${randomUUID().replaceAll('-', '').repeat(2)}` }));
  for (const n of [0, 16, 64, 256]) {
    await unrelated.append(n === 16 ? 0 : n === 64 ? 16 : n === 256 ? 64 : 0, n);
    if (n) await graph.update(`PREFIX rv: <${RV}> INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
      ${background.slice(n === 16 ? 0 : n === 64 ? 16 : 64, n).map(item => `${iri(item.observation)}
        a rv:RatingObservation ; rv:ratingContext ${iri(item.context)} ; rv:targetMainVersion ${iri(work.mainVersion)} ;
        rv:ratingSlot ${iri(item.slot)} ; rv:observationHead ${iri(item.revision)} .`).join('\n')}
    } GRAPH ${iri(GRAPHS.revisions)} {
      ${background.slice(n === 16 ? 0 : n === 64 ? 16 : 64, n).map(item => `${iri(item.revision)}
        a rv:RatingObservationRevision ; rv:component ${iri(corrected.observation)} ; rv:ratingValue 1 .`).join('\n')} } }`);
    await all(`growth-${n}`, finalMeans);
    plans.push((await accessPool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF) ${RATING_INVENTORY_SQL}`,
      [context, work.mainVersion])).rows[0]!['QUERY PLAN']);
  }
  const growth = costs.filter(cost => cost.branch.startsWith('growth-'));
  expect(new Set(growth.map(cost => cost.calls)).size).toBe(1);
  expect(new Set(growth.map(cost => cost.sqlCalls)).size).toBe(1);
  expect(Math.max(...growth.map(cost => cost.responseBytes)) - Math.min(...growth.map(cost => cost.responseBytes))).toBeLessThan(1024);
  function nodes(plan: Record<string, unknown>): Record<string, unknown>[] {
    return [plan, ...((plan.Plans as Record<string, unknown>[] | undefined) ?? []).flatMap(nodes)];
  }
  for (const plan of plans as { Plan: Record<string, unknown> }[][]) {
    const inventoryNodes = nodes(plan[0]!.Plan).filter(node => node['Relation Name'] === 'rating_aggregate_head');
    expect(inventoryNodes).toHaveLength(1);
    expect(inventoryNodes[0]!['Index Name']).toBe('rating_aggregate_head_pkey');
    expect(inventoryNodes[0]!['Actual Rows']).toBe(6);
    expect(inventoryNodes[0]!['Rows Removed by Filter'] ?? 0).toBe(0);
  }
  for (const node of nodes((plans.at(-1) as { Plan: Record<string, unknown> }[])[0]!.Plan)
    .filter(node => node['Relation Name'] === 'admission')) {
    expect(node['Index Name']).toBe('admission_pkey');
    expect(node['Actual Rows']).toBeLessThanOrEqual(1);
  }
  await unrelated.clear();
  const boundary = await ratingAggregateBackground(env, accessPool, { context, ...work }, corrected.observation, 95);
  await boundary.append(0, 94);
  expect((await all('100-slot-boundary', [7.5, 815 / 198, 2.27]))[0]!.population.observations).toBe(100);
  await boundary.append(94, 95);
  const overflow = await aggregate(EXPERIENCE_AGGREGATE_PROFILES[0]);
  expect(overflow.status).toBe(422);
  expect(await overflow.json()).toMatchObject({ code: 'query_budget_exceeded' });
  await boundary.clear();
  const finalResults = await all('before-recovery', finalMeans);
  const evidence = { baseline, initialDefault, changed, finalResults, recoveredResults: [] as Result[], inventoryCoverage, costs, plans,
    scope: 'Real APIs, owner inventory and graph/manifest recovery. Native Jena operator work and capacity remain unmeasured.' };
  function retainEvidence() {
    if (Bun.env.REZICS_QA_ARTIFACT_DIR) writeFileSync(join(Bun.env.REZICS_QA_ARTIFACT_DIR, 'rating-aggregate-evidence.json'), JSON.stringify(evidence, null, 2));
  }
  retainEvidence();
  return {
    async verifyRecovered(recovered: WorkActivationEnvironment) {
      const recoveredApi = createMainApp(recovered.fuseki, { environment: recovered, access: f.access, account: f.account });
      expect((await aggregate(EXPERIENCE_AGGREGATE_PROFILES[0], { context, ...work }, recoveredApi)).status).toBe(503);
      expect((await aggregate(EXPERIENCE_CONTEXT_DEFAULT_PROFILE, { context, ...work }, recoveredApi)).status).toBe(503);
      // Test-only reopen after the fixture has replayed every retained receipt twice.
      // This proves aggregate reconstruction, not the production owner-cut release gate.
      await recovered.fuseki.update(`PREFIX rv: <${RV}> DELETE DATA { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }`);
      const fence = (await accessPool.query('SELECT generation FROM access.recovery_fence WHERE id = true')).rows[0]!.generation;
      await accessPool.query('UPDATE access.recovery_fence SET open = true, generation = generation + 1 WHERE id = true AND generation = $1', [fence]);
      expect(await success<Result>(await aggregate(EXPERIENCE_CONTEXT_DEFAULT_PROFILE,
        { context, ...work }, recoveredApi), 200)).toMatchObject({
        policyRevision: changed.policyRevision, aggregationPolicy: 'mean-per-rater' });
      const results = await all('recovered', finalMeans, { context, ...work }, recoveredApi);
      expect(results.map(({ sourcePosition: _source, ...rest }) => rest))
        .toEqual(finalResults.map(({ sourcePosition: _source, ...rest }) => rest));
      evidence.recoveredResults = results;
      retainEvidence();
      // Restore the hold for the existing tampered-admission replay assertions.
      await recovered.fuseki.update(`PREFIX rv: <${RV}> INSERT DATA { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }`);
      await accessPool.query('UPDATE access.recovery_fence SET open = false, generation = generation + 1 WHERE id = true');
    },
  };
}
