import { randomBytes, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { createMainApp, type MainWorkDependencies } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { MANAGE_ACTION, MANAGE_SCOPE, RecommendationStale }
  from '../../../services/main/src/modules/recommendation/derived-generation.ts';
import { RankingBuildWorker } from '../../../services/main/src/modules/recommendation/build-worker.ts';
import { RANKING_PROFILE, type RankingBasis, RankingGenerations }
  from '../../../services/main/src/modules/recommendation/ranking.ts';
import type { RecommendationDependencies } from '../../../services/main/src/routes/recommendations.ts';
import { cloneOwners, grantAgent, meteredPool, nativeId, type RatingSignal, requireQa, retainBatch, slotOf,
  startAccount } from './recommendation-support.ts';

// Real Account tokens, Main HTTP handlers and isolated Access/relay clones. Relay
// envelopes are bulk-retained as the relay handoff writes them; each scenario
// uses its own data epoch, so one scenario's source faults never reach another.
const root = resolve(import.meta.dir, '../../..');
const state = join(root, '.temp', `recommendation-api-${randomUUID()}`);
let owners: Awaited<ReturnType<typeof cloneOwners>>;
let account: Awaited<ReturnType<typeof startAccount>>;
let access: Pool;
let relay: Pool;
let registry: AccessAdmissionRegistry;
let fuseki: FusekiClient;
let operatorToken = '';
let operatorReadToken = '';
let viewerToken = '';
let otherViewerToken = '';
let operator: Awaited<ReturnType<typeof grantAgent>>;
let viewer: Awaited<ReturnType<typeof grantAgent>>;
let otherViewer: Awaited<ReturnType<typeof grantAgent>>;
let outsiderToken = '';
let outsider: Awaited<ReturnType<typeof grantAgent>>;
let rater: Awaited<ReturnType<typeof grantAgent>>;

beforeAll(async () => {
  const runId = requireQa();
  owners = await cloneOwners(runId, ['access', 'relay']);
  access = new Pool({ connectionString: owners.urls.access, max: 8 });
  relay = new Pool({ connectionString: owners.urls.relay, max: 4 });
  registry = new AccessAdmissionRegistry(access);
  fuseki = new FusekiClient(Bun.env.FUSEKI_URL!);
  account = await startAccount('rating:configure rating:read');
  const [manager, reader, secondReader, stranger, ratingUser] = await Promise.all(
    ['manager', 'reader', 'second-reader', 'stranger', 'rater'].map(name => account.signUp(name)));
  operator = await grantAgent(access, account.issuer, manager!, MANAGE_SCOPE, MANAGE_ACTION);
  viewer = await grantAgent(access, account.issuer, reader!, 'work:read:none', 'work.read');
  otherViewer = await grantAgent(access, account.issuer, secondReader!, 'work:read:none', 'work.read');
  // Represents an Agent but holds no management grant.
  outsider = await grantAgent(access, account.issuer, stranger!, 'recommendation:other', MANAGE_ACTION);
  rater = await grantAgent(access, account.issuer, ratingUser!, 'rating:observe:fixture',
    'rating.observation.set');
  [operatorToken, operatorReadToken, viewerToken, otherViewerToken, outsiderToken] = await Promise.all([
    account.tokenFor(manager!, 'openid rating:configure'),
    account.tokenFor(manager!, 'openid rating:read'),
    account.tokenFor(reader!, 'openid rating:read'),
    account.tokenFor(secondReader!, 'openid rating:read'),
    account.tokenFor(stranger!, 'openid rating:configure rating:read')]);
}, 120_000);

afterAll(async () => {
  await account?.close();
  await Promise.all([access?.end(), relay?.end()]);
  await owners?.close();
  rmSync(state, { recursive: true, force: true });
}, 60_000);

/** One Main app over one relay epoch. The worker drives the same store directly. */
function scenario(options: { leaseMs?: number; signalBatches?: number;
  verifySemantic?: () => Promise<boolean>; zeroCandidates?: string[] } = {}) {
  const dataEpoch = randomUUID();
  const meter = meteredPool(access);
  const relayMeter = meteredPool(relay);
  let workChecks = 0;
  const store = new RankingGenerations({ access: meter.pool, relay: relayMeter.pool, dataEpoch,
    cursorKey: randomBytes(32), leaseMs: options.leaseMs, signalBatches: options.signalBatches,
    verifySemantic: options.verifySemantic,
    ...(options.zeroCandidates ? { zeroSnapshot: async () => '1',
      zeroCandidates: async (after: string | null, _snapshot: string, limit: number) =>
        options.zeroCandidates!.filter(candidate => !after || candidate > after).slice(0, limit) } : {}),
    canReadWork: (principal, subject, work) => { workChecks++; return registry.canReadWork(principal, subject, work); } });
  const dependencies: MainWorkDependencies & RecommendationDependencies = {
    environment: { fuseki, lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH!, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH! },
      objectDirectory: join(state, 'objects') },
    account: account.verifier, access: registry, recommendations: store };
  const main = createMainApp(fuseki, dependencies);
  let sequence = 0;
  const call = async (path: string, token: string, body?: object, key = `rec-${randomUUID()}`) => {
    const response = await main.handle(new Request(`http://main.local${path}`, {
      method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json', 'idempotency-key': key } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) }));
    return { status: response.status, body: await response.json() as Record<string, unknown> & {
      generation?: string; items?: { candidate: string }[]; continuation?: string | null; code?: string } };
  };
  const retain = async (signals: RatingSignal[]) => { sequence++;
    await retainBatch(relay, dataEpoch, sequence, signals,
      { access, principalId: rater.principalId, actingSubject: rater.agent }); };
  const build = async (basis: RankingBasis, key = `build-${randomUUID()}`, token = operatorToken, agent = operator.agent) =>
    call('/v1/recommendations/generation-builds', token,
      { profile: 'ranking-generation-build-v1', actingSubject: agent, basis, partitionCount: 4 }, key);
  const drain = async (generation: string, epoch: string) => {
    while ((await store.runBatch(generation, epoch)).relayBatches > 0) { /* bounded batches */ }
  };
  const ready = async (basis: RankingBasis): Promise<string> => {
    const registered = await build(basis);
    expect(registered.status).toBe(200);
    const generation = registered.body.generation!;
    const epoch = await store.claim(generation);
    await drain(generation, epoch);
    expect((await store.finish(generation, epoch)).state).toBe('ready');
    return generation;
  };
  const activate = (generation: string, expectedHeadRevision: string | null, key = `act-${randomUUID()}`,
    token = operatorToken, agent = operator.agent) => call('/v1/recommendations/generation-activations', token,
    { profile: 'ranking-generation-activation-v1', actingSubject: agent, generation, expectedHeadRevision }, key);
  const query = (basis: RankingBasis, pageSize: number, token = viewerToken, agent = viewer.agent) =>
    call('/v1/recommendations/queries', token, { profile: 'ranking-page-v1', actingSubject: agent, basis, pageSize });
  const next = (basis: RankingBasis, pageSize: number, continuation: string, token = viewerToken, agent = viewer.agent) =>
    call('/v1/recommendations/pages', token,
      { profile: 'ranking-page-v1', actingSubject: agent, basis, pageSize, continuation });
  /** All pages of the active generation, checking that every page keeps one generation. */
  const all = async (basis: RankingBasis, pageSize = 3, token = viewerToken, agent = viewer.agent) => {
    const first = await query(basis, pageSize, token, agent);
    expect(first.status).toBe(200);
    const items = [...first.body.items!];
    let continuation = first.body.continuation;
    while (continuation) {
      const page = await next(basis, pageSize, continuation, token, agent);
      expect(page.status).toBe(200);
      expect(page.body.generation).toBe(first.body.generation);
      items.push(...page.body.items!);
      continuation = page.body.continuation;
    }
    return items.map(item => item.candidate);
  };
  return { dataEpoch, store, meter, relayMeter, checks: () => workChecks, call, retain, build, drain, ready,
    activate, query, next, all };
}

const basisFor = (population: RankingBasis['population'], semantic: RankingBasis['semantic'] = null): RankingBasis =>
  ({ profile: RANKING_PROFILE, population, candidateGrain: 'work', semantic });

test('REC01: a semantic basis is denied when its current Context proof is unavailable', async () => {
  let proofs = 0;
  const s = scenario({ verifySemantic: async () => { proofs++; return false; } });
  const basis = basisFor({ kind: 'personal' }, { context: nativeId(), contextRevision: nativeId(),
    selectionRevision: randomUUID(), preferenceRevision: null });
  expect((await s.build(basis, undefined, outsiderToken, outsider.agent)).status).toBe(403);
  expect(proofs).toBe(0);
  expect((await s.build(basis)).status).toBe(403);
  expect(proofs).toBe(1);
  expect((await access.query(`SELECT 1 FROM access.derived_generation_input WHERE data_epoch = $1`,
    [s.dataEpoch])).rowCount).toBe(0);
}, 120_000);

test('REC01: positive scores precede eligible zero-score Works across one cursor', async () => {
  const [rated, zeroA, zeroB] = [1, 2, 3].map(number =>
    `https://rezics.com/id/00000000-0000-4000-8000-${String(number).padStart(12, '0')}`);
  const s = scenario({ zeroCandidates: [rated!, zeroA!, zeroB!] });
  await readable(viewer.agent, [rated!, zeroA!, zeroB!]);
  await s.retain([{ work: rated!, realm: nativeId(), slot: slotOf(randomUUID()),
    observation: nativeId(), value: 5 }]);
  const basis = basisFor({ kind: 'public' });
  expect((await s.activate(await s.ready(basis), null)).status).toBe(200);
  expect(await s.all(basis, 1)).toEqual([rated, zeroA, zeroB]);
}, 120_000);

test('REC02: production runner advances a registered generation in bounded ticks', async () => {
  const s = scenario({ signalBatches: 1 });
  const work = nativeId();
  await s.retain([{ work, realm: nativeId(), slot: slotOf(randomUUID()),
    observation: nativeId(), value: 8 }]);
  await s.retain([]);
  const generation = (await s.build(basisFor({ kind: 'public' }))).body.generation!;
  const worker = new RankingBuildWorker(access, s.store);
  await worker.tick();
  expect((await access.query('SELECT state FROM access.derived_generation WHERE id = $1', [generation]))
    .rows[0].state).toBe('building');
  for (let attempt = 0; attempt < 4; attempt++) await worker.tick();
  expect((await access.query('SELECT state FROM access.derived_generation WHERE id = $1', [generation]))
    .rows[0].state).toBe('ready');
}, 120_000);

test('REC05: an account erasure withholds its viewer without disclosing a target', async () => {
  const s = scenario();
  const work = nativeId();
  const erasedUser = await account.signUp('erased-reader');
  const erasedAgent = await grantAgent(access, account.issuer, erasedUser,
    'work:read:none', 'work.read');
  const erasedToken = await account.tokenFor(erasedUser, 'openid rating:read');
  await readable(erasedAgent.agent, [work]);
  await readable(otherViewer.agent, [work]);
  await s.retain([{ work, realm: nativeId(), slot: slotOf(randomUUID()),
    observation: nativeId(), value: 7 }]);
  const basis = basisFor({ kind: 'public' });
  expect((await s.activate(await s.ready(basis), null)).status).toBe(200);
  expect((await s.query(basis, 1, erasedToken, erasedAgent.agent)).body.items).toEqual([{ candidate: work }]);
  await relay.query(`INSERT INTO relay.account_subject_deletion (issuer, account_subject)
    VALUES ($1, $2)`, [account.issuer, erasedUser.id]);
  const denied = await s.query(basis, 1, erasedToken, erasedAgent.agent);
  expect(denied.status).toBe(404);
  expect(JSON.stringify(denied.body)).not.toContain(work);
  expect((await s.query(basis, 1, otherViewerToken, otherViewer.agent)).body.items)
    .toEqual([{ candidate: work }]);
}, 120_000);

test('REC05: erased rating contributor invalidates the old generation and rebuild omits the signal', async () => {
  const s = scenario();
  const erasedUser = await account.signUp('erased-contributor');
  const contributor = await grantAgent(access, account.issuer, erasedUser,
    'rating:observe:fixture', 'rating.observation.set');
  const affected = nativeId();
  const unaffected = nativeId();
  await readable(viewer.agent, [affected, unaffected]);
  await s.retain([
    { work: affected, realm: nativeId(), slot: slotOf(randomUUID()), observation: nativeId(),
      value: 10, contributorPrincipalId: contributor.principalId },
    { work: unaffected, realm: nativeId(), slot: slotOf(randomUUID()), observation: nativeId(), value: 4 },
  ]);
  const basis = basisFor({ kind: 'public' });
  const old = await s.ready(basis);
  expect((await s.activate(old, null)).status).toBe(200);
  expect(await s.all(basis)).toEqual([affected, unaffected]);
  await relay.query(`INSERT INTO relay.account_subject_deletion (issuer, account_subject)
    VALUES ($1, $2)`, [account.issuer, erasedUser.id]);
  const withheld = await s.query(basis, 2);
  expect(withheld).toMatchObject({ status: 409, body: { code: 'recommendation_restart' } });
  expect(JSON.stringify(withheld.body)).not.toContain(affected);
  const rebuilt = await s.ready(basis);
  expect((await s.activate(rebuilt, '1')).status).toBe(200);
  expect(await s.all(basis)).toEqual([unaffected]);
  const contributors = (await access.query<{ id: string }>(`SELECT DISTINCT contributor_principal_id::text AS id
    FROM access.ranking_signal_slot WHERE generation_id = $1`, [rebuilt])).rows;
  expect(contributors.map(row => row.id)).toEqual([rater.principalId]);
}, 120_000);

/** Grant the viewer Agent a current read on each candidate Work. */
async function readable(agent: string, works: string[]): Promise<void> {
  await access.query(`INSERT INTO access.scope_gate (id) SELECT 'work:read:' || w FROM unnest($1::text[]) w
    ON CONFLICT DO NOTHING`, [works]);
  await access.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
    SELECT gen_random_uuid(), $1, $1, 'work:read:' || w, 'work.read', now() + interval '1 hour'
    FROM unnest($2::text[]) w`, [agent, works]);
}

/** Sealed private inventory proving that one observation's slot belongs to one principal. */
async function ownSlot(principalId: string, agent: string, work: string, observation: string, slot: string) {
  const admission = randomUUID();
  await access.query("INSERT INTO access.scope_gate (id) VALUES ('rating:observe:g058') ON CONFLICT DO NOTHING");
  await access.query(`INSERT INTO access.admission (id, principal_id, acting_subject, scope_id, action,
    idempotency_key, request_digest, authority_epoch, expires_at, state)
    VALUES ($1, $2, $3, 'rating:observe:g058', 'rating.observation.set', $4, repeat('0', 64), 0,
      now() + interval '1 hour', 'registered')`, [admission, principalId, agent, `g058-${admission}`]);
  const context = nativeId();
  await access.query(`INSERT INTO access.rating_aggregate_context (context, realm, revision, admission_id)
    VALUES ($1, $2, $3, $4)`, [context, nativeId(), nativeId(), admission]);
  const second = randomUUID();
  await access.query(`INSERT INTO access.admission (id, principal_id, acting_subject, scope_id, action,
    idempotency_key, request_digest, authority_epoch, expires_at, state)
    VALUES ($1, $2, $3, 'rating:observe:g058', 'rating.observation.set', $4, repeat('0', 64), 0,
      now() + interval '1 hour', 'registered')`, [second, principalId, agent, `g058-${second}`]);
  await access.query(`INSERT INTO access.rating_aggregate_head (context, main_version, slot, work, observation,
    revision, principal_id, admission_id, original_admission_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
  [context, nativeId(), slot, work, observation, nativeId(), principalId, second]);
}

test('REC01: a ranking counts only admitted signals of its declared population and exact basis', async () => {
  const s = scenario();
  const [realmA, realmB] = [nativeId(), nativeId()];
  const [w1, w2, w3, w4] = [nativeId(), nativeId(), nativeId(), nativeId()];
  await readable(viewer.agent, [w1!, w2!, w3!, w4!]);
  await readable(operator.agent, [w4!]);
  await access.query(`INSERT INTO access.representation
    (id, principal_id, subject_id, action, valid_until)
    VALUES ($1, $2, $3, 'work.read', now() + interval '1 hour')`,
  [randomUUID(), operator.principalId, operator.agent]);
  const mine = { slot: slotOf(`mine-${randomUUID()}`), observation: nativeId() };
  await ownSlot(operator.principalId, operator.agent, w4!, mine.observation, mine.slot);
  const slot = () => ({ slot: slotOf(randomUUID()), observation: nativeId() });
  const corrected = slot();
  await s.retain([
    { work: w1!, realm: realmA!, ...slot(), value: 9 },
    { work: w2!, realm: realmA!, ...corrected, value: 10 },
    { work: w3!, realm: realmB!, ...slot(), value: 10 },
    { work: w4!, realm: realmB!, ...mine, value: 2, contributorPrincipalId: operator.principalId },
    // Not admitted: a cancelled command and a different event kind.
    { work: w3!, realm: realmA!, ...slot(), value: 10, outcome: 'cancelled' },
  ]);
  await s.retain([]);
  // A later correction of the same slot replaces its weight; it never adds a second vote.
  await s.retain([{ work: w2!, realm: realmA!, ...corrected, value: 3 }]);
  await retainBatch(relay, randomUUID(), 1, [{ work: w3!, realm: realmA!, ...slot(), value: 10 }],
    { access, principalId: rater.principalId, actingSubject: rater.agent });
  await s.retain([{ work: w1!, realm: realmA!, ...slot(), value: 1 }].map(signal => signal));
  await relay.query(`UPDATE relay.delivered_event SET envelope = jsonb_set(envelope, '{type}',
    '"com.rezics.rating.observation-stale.v1"') WHERE data_epoch = $1 AND sequence = 4`, [s.dataEpoch]);

  const realm = basisFor({ kind: 'realm', realm: realmA! });
  const everyone = basisFor({ kind: 'public' });
  const semantic = { context: nativeId(), contextRevision: nativeId(), selectionRevision: nativeId(),
    preferenceRevision: nativeId() };
  const personal = basisFor({ kind: 'personal' }, semantic);
  for (const basis of [realm, everyone, personal]) {
    expect((await s.activate(await s.ready(basis), null)).status).toBe(200);
  }
  expect(await s.all(realm)).toEqual([w1, w2]);
  expect(await s.all(everyone)).toEqual([w3, w1, w2, w4]);
  expect(await s.all(personal, 3, operatorReadToken, operator.agent)).toEqual([w4]);
  const rows = (await access.query<{ population: string; candidate: string; score: string }>(`SELECT r.population,
    s.candidate, s.score::text FROM access.ranking_score s JOIN access.ranking_generation r USING (generation_id)
    JOIN access.derived_generation_input i USING (generation_id) WHERE i.data_epoch = $1
    ORDER BY r.population, s.score DESC`, [s.dataEpoch])).rows;
  expect(rows.filter(row => row.population === 'realm').map(row => [row.candidate, row.score]))
    .toEqual([[w1, '9'], [w2, '3']]);
  // The personal ranking pins its exact semantic and preference basis. The same criterion
  // under a Realm population, or a newer preference revision, is a separate ranking.
  const pinned = (await access.query(`SELECT context, context_revision, semantic_selection_revision,
    preference_revision, principal_id::text FROM access.ranking_generation r
    JOIN access.derived_generation_input i USING (generation_id)
    WHERE i.data_epoch = $1 AND r.population = 'personal'`, [s.dataEpoch])).rows[0];
  expect(pinned).toEqual({ context: semantic.context, context_revision: semantic.contextRevision,
    semantic_selection_revision: semantic.selectionRevision, preference_revision: semantic.preferenceRevision,
    principal_id: operator.principalId });
  const privateSelection = randomUUID();
  expect((await s.build(basisFor({ kind: 'personal' },
    { ...semantic, selectionRevision: privateSelection }))).status).toBe(200);
  expect((await access.query(`SELECT 1 FROM access.ranking_generation
    WHERE principal_id = $1 AND semantic_selection_revision = $2`,
  [operator.principalId, privateSelection])).rowCount).toBe(1);
  expect((await s.query(basisFor({ kind: 'realm', realm: realmA! }, semantic), 5)).status).toBe(404);
  expect((await s.query(basisFor({ kind: 'personal' }, { ...semantic, preferenceRevision: nativeId() }), 5,
    operatorReadToken, operator.agent)).status)
    .toBe(404);
  // Another principal addressing "personal" reaches only its own (absent) population.
  expect((await s.query(personal, 5, viewerToken, viewer.agent)).status).toBe(404);
}, 120_000);

test('REC02: a hot target folds into bounded coalesced batches without a global counter', async () => {
  const s = scenario({ signalBatches: 10 });
  const hot = nativeId();
  const cold = Array.from({ length: 5 }, nativeId);
  await readable(viewer.agent, [hot, ...cold]);
  const raters = Array.from({ length: 400 }, (_, index) => ({ slot: slotOf(`hot-${s.dataEpoch}-${index}`),
    observation: nativeId() }));
  // 40 relay batches of 100 events: every rater revises the hot target ten times.
  for (let batch = 0; batch < 40; batch++) {
    await s.retain(Array.from({ length: 100 }, (_, index) => {
      const rater = raters[(batch * 100 + index) % raters.length]!;
      return { work: hot, realm: nativeId(), ...rater, value: ((batch + index) % 10) + 1 };
    }).map((signal, index) => (index < 5 ? { ...signal, work: cold[index]!, slot: slotOf(`cold-${batch}-${index}`) } : signal)));
  }
  const registered = await s.build(basisFor({ kind: 'public' }));
  const generation = registered.body.generation!;
  const epoch = await s.store.claim(generation);
  const costs: number[] = [];
  for (;;) {
    s.meter.reset();
    const result = await s.store.runBatch(generation, epoch);
    if (!result.relayBatches) break;
    expect(result.relayBatches).toBe(10);
    costs.push(s.meter.count());
  }
  // Four batches of 1,000 events each cost the same bounded statement count.
  expect(costs).toHaveLength(4);
  expect(new Set(costs).size).toBe(1);
  expect(costs[0]).toBeLessThanOrEqual(14);
  expect((await s.store.finish(generation, epoch)).state).toBe('ready');
  const latest = new Map<string, number>();
  for (let batch = 0; batch < 40; batch++) {
    for (let index = 5; index < 100; index++) {
      latest.set(raters[(batch * 100 + index) % raters.length]!.slot, ((batch + index) % 10) + 1);
    }
  }
  const expected = [...latest.values()].reduce((sum, value) => sum + value, 0);
  const hotRow = (await access.query<{ score: string; signal_count: string; partition: number }>(`SELECT score::text,
    signal_count::text, partition FROM access.ranking_score WHERE generation_id = $1 AND candidate = $2`,
  [generation, hot])).rows[0]!;
  expect(hotRow).toMatchObject({ score: String(expected), signal_count: String(latest.size) });
  const partitions = (await access.query<{ partition: number; score_total: string }>(`SELECT partition,
    score_total::text FROM access.ranking_partition WHERE generation_id = $1 ORDER BY partition`, [generation])).rows;
  expect(partitions).toHaveLength(4);
  const coldTotal = 40 * [1, 2, 3, 4, 5].length;
  expect(partitions.reduce((sum, row) => sum + Number(row.score_total), 0)).toBeGreaterThanOrEqual(expected + coldTotal);
  // Slots, not events, carry state: 380 hot raters plus 200 cold slots.
  expect((await access.query('SELECT count(*)::int AS n FROM access.ranking_signal_slot WHERE generation_id = $1',
    [generation])).rows[0].n).toBe(580);
}, 180_000);

test('REC03: a failed second generation leaves the first active and served', async () => {
  const s = scenario();
  const works = [nativeId(), nativeId(), nativeId()];
  await readable(viewer.agent, works);
  const basis = basisFor({ kind: 'public' });
  await s.retain(works.map((work, index) => ({ work, realm: nativeId(), slot: slotOf(randomUUID()),
    observation: nativeId(), value: 10 - index })));
  const first = await s.ready(basis);
  expect((await s.activate(first, null)).body).toMatchObject({ headRevision: '1', predecessor: null });
  const before = await s.all(basis);
  expect(before).toEqual(works);
  // A malformed retained envelope fails the next build instead of being skipped.
  await s.retain([{ work: works[2]!, realm: nativeId(), slot: 'urn:rezics:rating-slot:bad', observation: nativeId(), value: 10 }]);
  const second = (await s.build(basis)).body.generation!;
  const epoch = await s.store.claim(second);
  expect((await s.store.runBatch(second, epoch)).failed).toBe('source-invalid');
  const failed = await s.call(`/v1/recommendations/generations/${second}?actingSubject=${encodeURIComponent(operator.agent)}`, operatorToken);
  expect(failed.body).toMatchObject({ state: 'failed', failureReason: 'source-invalid', activeRevision: null });
  const refused = await s.activate(second, '1');
  expect(refused).toMatchObject({ status: 409, body: { code: 'generation_not_ready' } });
  const head = await s.call(`/v1/recommendations/generations/${first}?actingSubject=${encodeURIComponent(operator.agent)}`, operatorToken);
  expect(head.body).toMatchObject({ state: 'ready', activeRevision: '1' });
  expect(await s.all(basis)).toEqual(before);
  await expect(s.store.finish(second, epoch)).rejects.toBeInstanceOf(RecommendationStale);
}, 120_000);

test('REC04: a stale worker cannot overwrite, finish or activate over a newer generation', async () => {
  const s = scenario({ leaseMs: 400, signalBatches: 1 });
  const works = [nativeId(), nativeId(), nativeId(), nativeId()];
  await readable(viewer.agent, works);
  for (const [index, work] of works.entries()) {
    await s.retain([{ work, realm: nativeId(), slot: slotOf(randomUUID()), observation: nativeId(), value: index + 1 }]);
  }
  const basis = basisFor({ kind: 'public' });
  const generation = (await s.build(basis)).body.generation!;
  const stale = await s.store.claim(generation);
  expect((await s.store.runBatch(generation, stale)).checkpoint).toBe('1');
  // The first worker stalls past its lease; a replacement resumes from the durable checkpoint.
  await Bun.sleep(500);
  const current = await s.store.claim(generation);
  expect(BigInt(current)).toBe(BigInt(stale) + 1n);
  await expect(s.store.runBatch(generation, stale)).rejects.toBeInstanceOf(RecommendationStale);
  expect((await s.store.runBatch(generation, current)).checkpoint).toBe('2');
  await s.drain(generation, current);
  await expect(s.store.finish(generation, stale)).rejects.toBeInstanceOf(RecommendationStale);
  expect((await s.store.finish(generation, current)).state).toBe('ready');
  expect((await s.activate(generation, null)).status).toBe(200);
  // A newer build becomes active; the stale activation request and the old generation lose the CAS.
  await s.retain([{ work: works[0]!, realm: nativeId(), slot: slotOf(randomUUID()), observation: nativeId(), value: 10 }]);
  const newer = await s.ready(basis);
  expect((await s.activate(newer, '1')).body).toMatchObject({ headRevision: '2', predecessor: generation });
  expect(await s.activate(generation, '1')).toMatchObject({ status: 409, body: { code: 'stale_head' } });
  expect(await s.activate(generation, '2')).toMatchObject({ status: 409, body: { code: 'generation_not_ready' } });
  await expect(s.store.runBatch(newer, current)).rejects.toBeInstanceOf(RecommendationStale);
  expect((await s.query(basis, 5)).body.generation).toBe(newer);
  expect(await s.all(basis)).toEqual([works[0], works[3], works[2], works[1]]);
}, 120_000);

test('REC05: private or erased candidates are withheld at delivery without counts or reasons', async () => {
  const s = scenario();
  const works = Array.from({ length: 6 }, nativeId);
  await readable(viewer.agent, works);
  await readable(otherViewer.agent, works);
  await s.retain(works.map((work, index) => ({ work, realm: nativeId(), slot: slotOf(randomUUID()),
    observation: nativeId(), value: 10 - index })));
  const basis = basisFor({ kind: 'public' });
  await s.activate(await s.ready(basis), null);
  const baseline = await s.query(basis, 2);
  expect(baseline.body.items!.map(item => item.candidate)).toEqual([works[0], works[1]]);
  // After ranking: the viewer loses read access to one Work and another Work is erased.
  await access.query(`UPDATE access.permission_grant SET active = false WHERE recipient_subject = $1
    AND scope_id = $2`, [viewer.agent, `work:read:${works[1]}`]);
  const erasure = randomUUID();
  await relay.query(`INSERT INTO relay.erasure (id, erasure_epoch, operation_id, request_digest, kind, authority,
    principal_id, admission_id, authority_epoch) VALUES ($1, relay.next_erasure_epoch(), $2, repeat('a', 64),
    'resource', 'access_admission', $3, $4, 1)`, [erasure, `g058-${erasure}`, randomUUID(), randomUUID()]);
  await relay.query(`INSERT INTO relay.erasure_target (erasure_id, ordinal, owner, target_kind, target_ref)
    VALUES ($1, 1, 'graph', 'resource', $2)`, [erasure, works[3]]);
  const pages = [];
  let page = await s.query(basis, 2);
  pages.push(page);
  while (page.body.continuation) {
    page = await s.next(basis, 2, page.body.continuation);
    pages.push(page);
  }
  expect(pages.flatMap(item => item.body.items!.map(entry => entry.candidate)))
    .toEqual([works[0], works[2], works[4], works[5]]);
  for (const item of pages) {
    // Same fields, sealed fixed-length continuation, no totals, skipped count or reason.
    expect(Object.keys(item.body).sort()).toEqual(Object.keys(baseline.body).sort());
    if (item.body.continuation) expect(item.body.continuation.length).toBe(baseline.body.continuation!.length);
    expect(JSON.stringify(item.body)).not.toContain(works[1]!);
    expect(JSON.stringify(item.body)).not.toContain(works[3]!);
  }
  // Disclosure is per viewer: the other reader still sees the Work it may read, never the erased one.
  expect(await s.all(basis, 3, otherViewerToken, otherViewer.agent))
    .toEqual([works[0], works[1], works[2], works[4], works[5]]);
  // Delivery rechecks at most two candidates per requested item.
  expect(s.checks()).toBeLessThanOrEqual(2 * 2 * pages.length + 2 * 3 * 4 + 4);
}, 120_000);

test('REC04: concurrent first activations serialize the absent head into success and stale receipt', async () => {
  const s = scenario();
  const work = nativeId();
  await readable(viewer.agent, [work]);
  await s.retain([{ work, realm: nativeId(), slot: slotOf(randomUUID()),
    observation: nativeId(), value: 8 }]);
  const basis = basisFor({ kind: 'public' });
  const [first, second] = await Promise.all([s.ready(basis), s.ready(basis)]);
  const [a, b] = await Promise.all([s.activate(first, null), s.activate(second, null)]);
  expect([a.status, b.status].sort()).toEqual([200, 409]);
  const winner = a.status === 200 ? first : second;
  expect((await s.query(basis, 2)).body.generation).toBe(winner);
  const receipts = (await access.query<{ outcome: string }>(`SELECT outcome FROM access.derived_generation_receipt
    WHERE generation_id = ANY($1::uuid[]) AND action = 'activate' ORDER BY outcome`, [[first, second]])).rows;
  expect(receipts.map(row => row.outcome)).toEqual(['stale_head', 'succeeded']);
}, 120_000);

test('REC04: a new source epoch fences an old worker and activation', async () => {
  const old = scenario();
  const basis = basisFor({ kind: 'public' });
  const generation = (await old.build(basis)).body.generation!;
  const current = scenario();
  await expect(current.store.claim(generation)).rejects.toBeInstanceOf(RecommendationStale);
  await expect(current.store.runBatch(generation, '1')).rejects.toBeInstanceOf(RecommendationStale);
  await expect(current.store.finish(generation, '1')).rejects.toBeInstanceOf(RecommendationStale);
  expect(await current.activate(generation, null)).toMatchObject({ status: 409,
    body: { code: 'recommendation_stale' } });
  expect((await access.query('SELECT state FROM access.derived_generation WHERE id = $1',
    [generation])).rows[0].state).toBe('building');
}, 120_000);

test('REC06: a cursor on an expired generation restarts explicitly; pages never mix orders', async () => {
  const s = scenario();
  const works = Array.from({ length: 6 }, nativeId);
  await readable(viewer.agent, works);
  const semantic = { context: nativeId(), contextRevision: nativeId(), selectionRevision: nativeId(),
    preferenceRevision: nativeId() };
  const basis = basisFor({ kind: 'public' }, semantic);
  const slots = works.map(() => ({ slot: slotOf(randomUUID()), observation: nativeId() }));
  const vote = (work: string, index: number, value: number) => ({ work, realm: nativeId(), ...slots[index]!,
    value });
  await s.retain(works.map((work, index) => vote(work, index, 10 - index)));
  const first = await s.ready(basis);
  await s.activate(first, null);
  const page1 = await s.query(basis, 2);
  expect(page1.body.items!.map(item => item.candidate)).toEqual(works.slice(0, 2));
  // The next generation reverses the order; the old cursor keeps its own generation's order.
  await s.retain(works.map((work, index) => vote(work, index, 5 + index)));
  const second = await s.ready(basis);
  await s.activate(second, '1');
  const page2 = await s.next(basis, 2, page1.body.continuation!);
  expect(page2.body).toMatchObject({ generation: first, items: works.slice(2, 4).map(candidate => ({ candidate })) });
  const fresh = await s.query(basis, 2);
  expect(fresh.body.generation).toBe(second);
  expect(fresh.body.items!.map(item => item.candidate)).toEqual([works[5], works[4]]);
  // Changing the preference ordering, the selection or the viewer never continues an old cursor.
  const restart = { status: 409, body: { code: 'recommendation_restart' } };
  expect(await s.next({ ...basis, semantic: { ...semantic, preferenceRevision: nativeId() } }, 2,
    page2.body.continuation!)).toMatchObject(restart);
  expect(await s.next({ ...basis, semantic: { ...semantic, selectionRevision: nativeId() } }, 2,
    page2.body.continuation!)).toMatchObject(restart);
  expect(await s.next(basis, 2, page2.body.continuation!, otherViewerToken, otherViewer.agent)).toMatchObject(restart);
  const tampered = `${page2.body.continuation!.slice(0, -2)}AA`;
  expect(await s.next(basis, 2, tampered)).toMatchObject(restart);
  // Retention keeps three generations per scope; the fourth activation expires the first.
  const third = await s.ready(basis);
  await s.activate(third, '2');
  expect((await s.next(basis, 2, page2.body.continuation!)).status).toBe(200);
  const fourth = await s.ready(basis);
  await s.activate(fourth, '3');
  expect(await s.next(basis, 2, page2.body.continuation!)).toMatchObject(restart);
  expect((await access.query('SELECT state FROM access.derived_generation WHERE id = $1', [first])).rows[0].state)
    .toBe('expired');
  expect(await s.store.purgeExpired(first)).toBeGreaterThan(0);
  expect((await s.query(basis, 2)).body.generation).toBe(fourth);
}, 180_000);

test('REC03/REC04: template receipts replay, denials and recovery holds leave no effect; rebuild reproduces', async () => {
  const s = scenario();
  const works = [nativeId(), nativeId()];
  await readable(viewer.agent, works);
  await s.retain(works.map((work, index) => ({ work, realm: nativeId(), slot: slotOf(randomUUID()),
    observation: nativeId(), value: 5 + index })));
  const basis = basisFor({ kind: 'public' });
  const counts = async () => (await access.query<{ n: number }>(`SELECT count(*)::int AS n
    FROM access.derived_generation_input WHERE data_epoch = $1`, [s.dataEpoch])).rows[0]!.n;
  // Idempotency: a lost response replays the same generation; a changed intent conflicts.
  const first = await s.build(basis, 'build-once');
  const replay = await s.build(basis, 'build-once');
  expect(replay.body).toMatchObject({ generation: first.body.generation, replayed: true });
  expect((await s.call('/v1/recommendations/generation-builds', operatorToken, { profile: 'ranking-generation-build-v1',
    actingSubject: operator.agent, basis, partitionCount: 8 }, 'build-once'))).toMatchObject({ status: 409,
    body: { code: 'idempotency_conflict' } });
  expect(await counts()).toBe(1);
  // Denial: no management grant, wrong token scope, missing idempotency key.
  expect(await s.build(basis, undefined, outsiderToken, outsider.agent)).toMatchObject({ status: 403 });
  expect((await s.build(basis, undefined, viewerToken, viewer.agent)).status).toBe(401);
  expect(await counts()).toBe(1);
  // Recovery hold: every owner operation is unavailable and writes nothing.
  const generation = first.body.generation!;
  const epoch = await s.store.claim(generation);
  await s.drain(generation, epoch);
  await s.store.finish(generation, epoch);
  await access.query('UPDATE access.recovery_fence SET open = false WHERE id = true');
  try {
    expect((await s.build(basis)).status).toBe(503);
    expect((await s.activate(generation, null)).status).toBe(503);
    expect((await s.query(basis, 2)).status).toBe(503);
  } finally {
    await access.query('UPDATE access.recovery_fence SET open = true WHERE id = true');
  }
  expect(await counts()).toBe(1);
  const activation = await s.activate(generation, null, 'activate-once');
  expect(activation.status).toBe(200);
  expect((await s.activate(generation, null, 'activate-once')).body).toMatchObject({ replayed: true, headRevision: '1' });
  expect((await s.activate(generation, '1', 'activate-once'))).toMatchObject({ status: 409,
    body: { code: 'idempotency_conflict' } });
  // Derived loss recovery: a rebuild from retained relay envelopes validates to the same digest.
  const rebuilt = await s.ready(basis);
  const digests = (await access.query<{ validation_digest: string }>(`SELECT validation_digest
    FROM access.derived_generation WHERE id = ANY($1::uuid[])`, [[generation, rebuilt]])).rows;
  expect(new Set(digests.map(row => row.validation_digest)).size).toBe(1);
}, 120_000);

test('REC05/REC06: page cost uses the same statements for 10 and 400 ranked candidates', async () => {
  const costs = [];
  let largeGeneration = '';
  for (const size of [10, 400]) {
    const s = scenario();
    const works = Array.from({ length: size }, nativeId);
    await readable(viewer.agent, works);
    await s.retain(works.slice(0, 100).map(work => ({ work, realm: nativeId(), slot: slotOf(randomUUID()),
      observation: nativeId(), value: 7 })));
    for (let offset = 100; offset < size; offset += 100) {
      await s.retain(works.slice(offset, offset + 100).map(work => ({ work, realm: nativeId(),
        slot: slotOf(randomUUID()), observation: nativeId(), value: 3 })));
    }
    const basis = basisFor({ kind: 'public' });
    const generation = await s.ready(basis);
    if (size === 400) largeGeneration = generation;
    await s.activate(generation, null);
    const first = await s.query(basis, 5);
    s.meter.reset();
    s.relayMeter.reset();
    const before = s.checks();
    const page = await s.next(basis, 5, first.body.continuation!);
    expect(page.body.items).toHaveLength(5);
    costs.push({ access: s.meter.count(), relay: s.relayMeter.count(), visibility: s.checks() - before });
  }
  expect(costs[0]).toEqual(costs[1]);
  expect(costs[0]!.relay).toBe(3);
  expect(costs[0]!.visibility).toBe(5);
  await access.query('ANALYZE access.ranking_score');
  const plan = (await access.query<{ 'QUERY PLAN': string }>(`EXPLAIN SELECT candidate, score FROM access.ranking_score
    WHERE generation_id = $1 ORDER BY score DESC, candidate LIMIT 11`, [largeGeneration])).rows
    .map(row => row['QUERY PLAN']).join('\n');
  expect(plan).toContain('ranking_score_order');
}, 180_000);
