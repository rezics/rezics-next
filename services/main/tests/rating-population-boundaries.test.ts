import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Pool } from 'pg';
import { AccessAdmissionRegistry } from '../src/modules/access/admission.ts';
import { fusekiReadBudget, FusekiReadBudgetExceeded, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { checkRatingAggregateFence, STANDING_RATING_INVENTORY_SQL, type RatingAggregateInventory, type RatingInventoryHead } from '../src/modules/rating/aggregate-inventory.ts';
import { RatingAggregateUnavailable } from '../src/modules/rating/aggregate.ts';
import { RATING_ACCOUNT_POPULATION, RATING_LATEST_MEAN_POLICY, RATING_STANDING_CADENCE,
  REALM_STANDING_RATING_CONTEXT_PROFILE } from '../src/modules/rating/context.ts';
import { GLOBAL_CONTEXT_PROFILE, GLOBAL_OBSERVATION_PROFILE, GLOBAL_RATING_POPULATION,
  GLOBAL_RATING_POPULATION_OWNER, globalRatingDigest } from '../src/modules/rating/global.ts';
import { GLOBAL_AGGREGATE_BUDGET, queryGlobalRatingAggregate, queryRealmGlobalSynthesis,
  queryWorkStandingRating, queryWorkStandingRatings } from '../src/modules/rating/global-aggregate.ts';
import { STANDING_RATING_OBSERVATION_PROFILE, standingRatingDigest } from '../src/modules/rating/observation.ts';
import { reduceStandingCounts, reduceStandingComponent } from '../src/modules/rating/synthesis.ts';
import { prepareComponent, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';

type Row = NonNullable<SparqlResult['results']>['bindings'][number];
const id = (n: number) => `https://rezics.com/id/019d0000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const work = id(1), mainVersion = id(2), actor = id(3), globalContext = id(4), realmContext = id(5), realm = id(6);
const originWork = id(7), originMain = id(8);
const uri = (value: string) => ({ type: 'uri', value });
const literal = (value: string) => ({ type: 'literal', value });
const inventories: Record<string, RatingAggregateInventory> = {};
const rows: Record<string, Row[]> = {};
const inheritedEvidence: Record<string, { head: RatingInventoryHead; row: Row }> = {};
let directory: string;

// Immutable data is built once. Every case gets isolated owner snapshots; the
// large-population cases supply additive figures, not thousands of fake graph rows.
beforeAll(() => {
  const scratch = resolve(import.meta.dir, '../../../.temp');
  mkdirSync(scratch, { recursive: true });
  directory = mkdtempSync(join(scratch, 'standing-boundaries-'));
  let next = 100;
  for (const kind of ['global', 'realm'] as const) {
    const context = kind === 'global' ? globalContext : realmContext;
    const owner = kind === 'global' ? GLOBAL_RATING_POPULATION_OWNER : realm;
    const contextRevision = id(next++), question = `${kind} quality`;
    const profile = kind === 'global' ? GLOBAL_CONTEXT_PROFILE : REALM_STANDING_RATING_CONTEXT_PROFILE;
    const contextManifest = prepareComponent(directory, context, { context,
      ...(kind === 'global' ? { populationOwner: owner } : { realm: owner }), question, state: 'active',
      targetGrain: 'MainVersion', scaleMin: 1, scaleMax: kind === 'global' ? 5 : 10,
      cadence: RATING_STANDING_CADENCE, populationPolicy: kind === 'global' ? GLOBAL_RATING_POPULATION : RATING_ACCOUNT_POPULATION,
      aggregationPolicy: RATING_LATEST_MEAN_POLICY }, profile);
    const inventory: RatingAggregateInventory = { realm: owner, contextRevision, policyRevision: contextRevision,
      recoveryGeneration: '7', contextReceipt: `urn:rezics:context:${kind}`, contextDataEpoch: 'epoch',
      contextSequence: '1', heads: [] };
    rows[context] = [{ kind: literal('context'), component: literal(kind), epoch: literal('epoch'), sequence: literal('1000'),
      owner: uri(owner), contextRevision: uri(contextRevision), contextManifest: uri(`urn:rezics:sha256:${contextManifest}`),
      question: { type: 'literal', value: question, 'xml:lang': 'en' }, contextEpoch: literal('epoch'),
      contextSequence: literal('1'), receipt: uri(inventory.contextReceipt), scaleMin: literal('1'),
      scaleMax: literal(kind === 'global' ? '5' : '10') }];
    const values = kind === 'global' ? Array<number>(101).fill(5) : [8, 6, ...Array<number>(99).fill(8)];
    for (const [index, value] of [...values, values.at(-1)!].entries()) {
      const inherited = index === 101, originalWork = inherited ? originWork : work, originalMain = inherited ? originMain : mainVersion;
      const observation = id(next++), revision = id(next++), slot = `urn:rezics:rating-slot:${String(next).padStart(64, '0')}`;
      const time = new Date(Date.UTC(2026, 9, 19, 0, 0, index)).toISOString();
      const digest = (kind === 'global' ? globalRatingDigest : standingRatingDigest)({ context, work: originalWork, mainVersion: originalMain, value,
        expectedRevisionHead: null, actingSubject: actor });
      const manifest = prepareComponent(directory, observation, { observation, revision, slot, context, contextRevision,
        ...(kind === 'global' ? { populationOwner: owner } : { realm: owner }), work: originalWork, mainVersion: originalMain, value,
        predecessor: null, availability: 'available', evaluatedAt: time, submittedAt: time,
        originalSubmissionAt: time, revisedAt: time },
      kind === 'global' ? GLOBAL_OBSERVATION_PROFILE : STANDING_RATING_OBSERVATION_PROFILE);
      const receipt = `urn:rezics:observation:${kind}:${index}`;
      const head = { slot, work: originalWork, mainVersion: originalMain, observation, revision, raterKey: `${kind}:${index}`,
        actingSubject: actor, requestDigest: digest, evaluatedAt: time, submittedAt: time, receipt,
        dataEpoch: 'epoch', sequence: String(index + 2) };
      const row = { kind: literal('observation'), component: literal(kind), epoch: literal('epoch'), sequence: literal('1000'),
        observation: uri(observation), slot: uri(slot), head: uri(revision), availability: uri('https://rezics.com/vocab/Available'),
        value: literal(String(value)), manifest: uri(`urn:rezics:sha256:${manifest}`), evaluatedAt: literal(time),
        submittedAt: literal(time), originalSubmissionAt: literal(time), revisedAt: literal(time),
        revisionEpoch: literal('epoch'), revisionSequence: literal(String(index + 2)), receipt: uri(receipt), digest: literal(digest) };
      if (inherited) inheritedEvidence[context] = { head, row };
      else { inventory.heads.push(head); rows[context]!.push(row); }
    }
    inventories[context] = inventory;
  }
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function fixture(population: number, realmPopulation = 2) {
  const inventory = structuredClone(inventories);
  const global = inventory[globalContext]!;
  global.heads = global.heads.slice(0, Math.min(population, 101));
  global.standing = { slots: population, unvalued: 0, histogram: population ? { '5': population } : {},
    witness: population > 100 ? global.heads.at(-1)! : null };
  const community = inventory[realmContext]!;
  community.heads = community.heads.slice(0, Math.min(realmPopulation, 101));
  community.standing = { slots: realmPopulation, unvalued: 0, histogram: realmPopulation < 2 ? { '8': realmPopulation }
    : { '8': realmPopulation - 1, '6': 1 }, witness: realmPopulation > 100 ? community.heads.at(-1)! : null };
  const realmRows = realmPopulation > 100 ? [rows[realmContext]![0]!, rows[realmContext]!.at(-1)!]
    : structuredClone(rows[realmContext]!.slice(0, realmPopulation + 1));
  const selectedRows = population > 100 ? [rows[globalContext]![0]!, rows[globalContext]!.at(-1)!]
    : structuredClone(rows[globalContext]!.slice(0, population + 1));
  const graph = { calls: 0, queries: [] as string[], rows: selectedRows,
    async query(query: string) {
      const budget = fusekiReadBudget.getStore()!;
      budget.signal.throwIfAborted();
      const bytes = Buffer.byteLength(JSON.stringify(this.rows));
      if (budget.callsLeft < 1 || budget.bytesLeft < bytes) throw new FusekiReadBudgetExceeded('fixture read budget exceeded');
      budget.callsLeft--; budget.bytesLeft -= bytes;
      this.calls++; this.queries.push(query);
      return { results: { bindings: this.rows } };
    } };
  const access = { fenceOpen: true, signals: [] as AbortSignal[],
    async readRatingAggregateInventory(context: string, _main: string, signal: AbortSignal, onlySlot?: string) {
      signal.throwIfAborted(); this.signals.push(signal);
      const result = structuredClone(inventory[context]!);
      if (onlySlot !== undefined) {
        result.heads = inventories[context]!.heads.filter(head => head.slot === onlySlot);
        result.selectedSlot = onlySlot;
        delete result.standing;
      }
      return result;
    },
    async checkRatingAggregateFence(_generation: string, signal: AbortSignal) { signal.throwIfAborted(); return this.fenceOpen; },
  };
  const env = { fuseki: graph, objectDirectory: directory, lineage: { dataEpoch: 'epoch', routingEpoch: '1' } } as unknown as WorkActivationEnvironment;
  return { inventory, graph, access, env, realmRows, read: () => queryGlobalRatingAggregate(env, access, { context: globalContext, work, mainVersion }) };
}

/** Only the external SQL transport is substituted. Registry, inventory,
 * synthesis, graph budget and immutable-manifest verifier compose unchanged.
 * Counts include transaction/control statements, as the retained native test
 * does. This verifies adapter work, not PostgreSQL execution or trigger work. */
function inventoryTransport(f: ReturnType<typeof fixture>) {
  const state = { generation: '0'.repeat(64), pending: '0', statements: [] as string[], differentCut: false,
    cuts: new Map<string, { generation: string; pending: string }>() };
  const current = (context: string, main: string) => state.cuts.get(`${context}|${main}`)
    ?? { pending: state.pending, generation: state.differentCut && context === globalContext ? '1'.repeat(64) : state.generation };
  const headRow = (head: RatingInventoryHead, index: number) => ({ slot: head.slot, work: head.work,
    main_version: head.mainVersion, target_release: null, observation: head.observation, revision: head.revision,
    principal_id: `019d0000-0000-7000-8000-${String(index).padStart(12, '0')}`,
    submitted_at: new Date(head.submittedAt), evaluated_at: new Date(head.evaluatedAt), acting_subject: head.actingSubject,
    request_digest: head.requestDigest, state: 'sealed', graph_outcome: 'succeeded', graph_receipt: head.receipt,
    graph_data_epoch: head.dataEpoch, graph_sequence: head.sequence, identity_valid: true });
  const client = { release() {}, async query(sql: string, values: string[] = []) {
    state.statements.push(sql);
    if (['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', "SET LOCAL statement_timeout = '5s'", 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
    if (sql === STANDING_RATING_INVENTORY_SQL) {
      const source = f.inventory[values[0]!]!;
      const component = source.standing ?? { slots: 2, unvalued: 0, histogram: { '6': 1, '8': 1 }, witness: null };
      const metadata = { realm: source.realm, context_revision: source.contextRevision, policy_revision: source.policyRevision,
        open: true, generation: source.recoveryGeneration, context_state: 'sealed', context_outcome: 'succeeded',
        context_receipt: source.contextReceipt, context_epoch: source.contextDataEpoch, context_sequence: source.contextSequence,
        pending: current(values[0]!, values[1]!).pending, standing_generation: current(values[0]!, values[1]!).generation };
      return { rows: (source.heads.length ? source.heads : [null]).map((head, index) => ({ ...metadata,
        ...(head ? headRow(head, index) : {}), ...(index ? {} : { standing_component: { ...component,
          witnesses: component.witness ? [headRow(component.witness, 100)] : null } }) })) };
    }
    if (sql.includes('AS standing_current')) {
      const cuts = JSON.parse(values[0]!) as { context: string; main_version: string; generation: string }[];
      return { rows: [{ open: true, generation: '7', standing_current: cuts.every(cut =>
        current(cut.context, cut.main_version).pending === '0' && cut.generation === current(cut.context, cut.main_version).generation) }] };
    }
    throw new Error(`Unexpected inventory statement: ${sql}`);
  } };
  const pool = { async connect() { return client; } } as unknown as Pool;
  return { state, pool, access: new AccessAdmissionRegistry(pool) };
}

test('composed synthesis retains nine SQL statements including controls at 100/101/large and empty boundaries', async () => {
  for (const [population, realmPopulation] of [[0, 2], [2, 2], [100, 100], [100, 101], [101, 100], [101, 101], [102, 2], [2048, 2048]] as const) {
    const f = fixture(population, realmPopulation), transport = inventoryTransport(f);
    f.graph.rows = [...f.realmRows, ...f.graph.rows];
    const result = await queryRealmGlobalSynthesis(f.env, transport.access, { realmContext, globalContext, work, mainVersion });
    expect(result.components.realm).toMatchObject({ count: realmPopulation, mean: (realmPopulation * 8 - 2) / realmPopulation });
    expect(result.components.global).toMatchObject({ count: population, mean: population ? 5 : null });
    expect(transport.state.statements).toHaveLength(9);
    expect(transport.state.statements.filter(sql => sql === STANDING_RATING_INVENTORY_SQL)).toHaveLength(2);
    expect(f.graph.calls).toBe(1);
  }
});

test('neither a native nor inherited witness can release an interrupted Realm or Global component', async () => {
  for (const context of [realmContext, globalContext]) {
    for (const inherited of [false, true]) {
      const f = fixture(101, 101);
      if (inherited) {
        const evidence = inheritedEvidence[context]!;
        f.inventory[context]!.standing!.witness = structuredClone(evidence.head);
        if (context === globalContext) f.graph.rows[1] = structuredClone(evidence.row);
        else f.realmRows[1] = structuredClone(evidence.row);
      }
      f.graph.rows = [...f.realmRows, ...f.graph.rows];
      const transport = inventoryTransport(f);
      expect((await queryRealmGlobalSynthesis(f.env, transport.access, { realmContext, globalContext, work, mainVersion }))
        .components.global.count).toBe(101);
      if (inherited) expect(f.graph.queries[0]).toContain(`<${originWork}>)`);
      expect(f.graph.queries[0]).toContain('rv:mergedInto+');
      transport.state.pending = '1'; // graph identity changed; owner pages remain unfinished
      await expect(queryRealmGlobalSynthesis(f.env, transport.access, { realmContext, globalContext, work, mainVersion }))
        .rejects.toBeInstanceOf(RatingAggregateUnavailable);
      expect(f.graph.calls).toBe(1);
    }
  }
});

test('search batches also reject a publication transition completed during their graph snapshot', async () => {
  const f = fixture(101), transport = inventoryTransport(f);
  f.graph.rows = f.graph.rows.map(row => ({ ...row, targetWork: uri(work) }));
  const query = f.graph.query.bind(f.graph);
  f.graph.query = async sql => { const result = await query(sql); transport.state.generation = '2'.repeat(64); return result; };
  await expect(queryWorkStandingRatings(f.env, transport.access, { kind: 'global', context: globalContext, targets: [{ work, mainVersion }] }))
    .rejects.toBeInstanceOf(RatingAggregateUnavailable);
  expect(transport.state.statements).toHaveLength(5);
});

test('standing publication is held across an affected pending transition and a transition completed during the graph read', async () => {
  for (const condition of ['pending', 'completed-during-read'] as const) {
    const f = fixture(101), transport = inventoryTransport(f);
    f.graph.rows = [...f.realmRows, ...f.graph.rows];
    if (condition === 'pending') transport.state.pending = '1';
    if (condition === 'completed-during-read') {
      const query = f.graph.query.bind(f.graph);
      f.graph.query = async sql => { const result = await query(sql); transport.state.generation = '2'.repeat(64); return result; };
    }
    await expect(queryRealmGlobalSynthesis(f.env, transport.access, { realmContext, globalContext, work, mainVersion }))
      .rejects.toBeInstanceOf(RatingAggregateUnavailable);
    expect(f.graph.calls).toBe(condition === 'completed-during-read' ? 1 : 0);
  }
});


test('independent Realm and Global publication cuts are checked together without requiring equality', async () => {
  const f = fixture(101, 102), transport = inventoryTransport(f);
  f.graph.rows = [...f.realmRows, ...f.graph.rows];
  transport.state.differentCut = true;
  const result = await queryRealmGlobalSynthesis(f.env, transport.access, { realmContext, globalContext, work, mainVersion });
  expect(result.components.realm.count).toBe(102);
  expect(result.components.global.count).toBe(101);
  expect(transport.state.statements).toHaveLength(9);
});

test('registry composition fences only the selected Work/Context cut and rejects an old cut after affected recovery', async () => {
  const f = fixture(102), transport = inventoryTransport(f);
  transport.state.cuts.set(`${realmContext}|${mainVersion}`, { generation: 'a'.repeat(64), pending: '1' });
  transport.state.cuts.set(`${globalContext}|${originMain}`, { generation: 'b'.repeat(64), pending: '1' });
  const read = () => queryGlobalRatingAggregate(f.env, transport.access, { context: globalContext, work, mainVersion });
  expect(await read()).toMatchObject({ complete: true, population: 102, count: 102, mean: 5 });
  expect(transport.state.statements).toHaveLength(5);
  const selected = { context: globalContext, mainVersion, generation: transport.state.generation };
  transport.state.cuts.set(`${globalContext}|${mainVersion}`, { generation: 'c'.repeat(64), pending: '1' });
  await expect(read()).rejects.toBeInstanceOf(RatingAggregateUnavailable);
  expect(f.graph.calls).toBe(1); // pending is rejected before graph work
  transport.state.cuts.set(`${globalContext}|${mainVersion}`, { generation: 'd'.repeat(64), pending: '0' });
  expect(await checkRatingAggregateFence(transport.pool, '7', undefined, [selected])).toBe(false);
  expect(await read()).toMatchObject({ complete: true, population: 102, count: 102, mean: 5 });
});

test('standing aggregates are exact at empty, 100, 101 and large populations within the original request budget', async () => {
  for (const population of [0, 1, 100, 101, 102, 512, 2048]) {
    const f = fixture(population);
    const result = await f.read();
    expect(result).toMatchObject({ complete: true, population, count: population, withdrawnCount: 0,
      sum: population * 5, mean: population ? 5 : null });
    expect(f.graph.calls).toBe(GLOBAL_AGGREGATE_BUDGET.graphCalls);
    expect(f.access.signals.every(signal => signal === f.access.signals[0])).toBe(true);
    if (population > 100) {
      expect(f.graph.queries[0]).not.toContain('SELECT DISTINCT ?observation');
      expect(f.graph.queries[0]!.length).toBeLessThan(10_000);
    }
    expect(JSON.stringify(result)).not.toMatch(/principalId|rating-slot:|raterKey/);
  }
});

test('large summaries retain withdrawals, independent community context and the search adapter', async () => {
  const f = fixture(2048);
  f.inventory[globalContext]!.standing!.histogram = { '5': 2047 };
  expect(await f.read()).toMatchObject({ count: 2047, withdrawnCount: 1, mean: 5 });
  const g = fixture(101);
  g.graph.rows = [...g.realmRows, ...g.graph.rows];
  const synthesized = await queryRealmGlobalSynthesis(g.env, g.access, { realmContext, globalContext, work, mainVersion });
  expect(synthesized.components.realm).toMatchObject({ count: 2, mean: 7 });
  expect(synthesized.components.global).toMatchObject({ count: 101, mean: 5 });
  expect(synthesized).not.toHaveProperty('count');
  const batch = fixture(512);
  batch.graph.rows = batch.graph.rows.map(row => ({ ...row, targetWork: uri(work) }));
  const values = await queryWorkStandingRatings(batch.env, batch.access, { kind: 'global', context: globalContext,
    targets: [{ work, mainVersion }] });
  expect(values.get(work)).toMatchObject({ count: 512, mean: 5 });
});

test('a reader slot is an indexed selection and never becomes the large population aggregate', async () => {
  for (const present of [true, false]) {
    const f = fixture(2048);
    const slot = present ? inventories[globalContext]!.heads[0]!.slot : `urn:rezics:rating-slot:${'f'.repeat(64)}`;
    f.graph.rows = structuredClone(rows[globalContext]!.slice(0, present ? 2 : 1));
    const result = await queryWorkStandingRating(f.env, f.access, { kind: 'global', context: globalContext,
      work, mainVersion, onlySlot: slot });
    expect(result).toMatchObject({ count: present ? 1 : 0, population: present ? 1 : 0, mean: present ? 5 : null });
    expect(f.graph.queries[0]).not.toContain('SELECT DISTINCT ?observation');
  }
});

test('unvalued, inconsistent, private or damaged evidence never becomes a truncated exact result', async () => {
  const damages = [
    (f: ReturnType<typeof fixture>) => { f.inventory[globalContext]!.standing!.unvalued = 1; },
    (f: ReturnType<typeof fixture>) => { f.inventory[globalContext]!.standing!.witness = null; },
    (f: ReturnType<typeof fixture>) => { f.inventory[globalContext]!.standing!.histogram = { '5': 102 }; },
    (f: ReturnType<typeof fixture>) => { f.graph.rows[1] = { ...f.graph.rows[1]!, receipt: uri('urn:missing') }; },
    (f: ReturnType<typeof fixture>) => { f.graph.rows = []; }, // Native public Context pattern has no root.
    (f: ReturnType<typeof fixture>) => { f.access.fenceOpen = false; },
  ];
  for (const damage of damages) {
    const f = fixture(101); damage(f);
    await expect(f.read()).rejects.toBeInstanceOf(RatingAggregateUnavailable);
  }
  const small = fixture(100);
  small.inventory[globalContext]!.standing!.histogram = { '5': 99 };
  await expect(small.read()).rejects.toBeInstanceOf(RatingAggregateUnavailable);
});

test('cancellation prevents graph work and an enclosing graph budget is still enforced', async () => {
  const f = fixture(2048), cancel = new AbortController();
  cancel.abort();
  await expect(fusekiReadBudget.run({ signal: cancel.signal, callsLeft: 1, bytesLeft: 1_048_576 }, f.read)).rejects.toThrow();
  expect(f.graph.calls).toBe(0);
  await expect(fusekiReadBudget.run({ signal: AbortSignal.timeout(1000), callsLeft: 0, bytesLeft: 1_048_576 }, f.read)).rejects.toThrow();
  expect(f.graph.calls).toBe(0);
});

test('weighted standing reduction preserves exact decimal scales without expanding the population', () => {
  const values = [0, 0.5, 0.5, 1, null], scale = { min: 0, max: 1, step: 0.5 };
  expect(reduceStandingCounts(5, new Map([[0, 1], [0.5, 2], [1, 1]]), scale)).toEqual(reduceStandingComponent(values, scale));
  expect(reduceStandingCounts(2_000_000_000, new Map([[0.5, 2_000_000_000]]), scale)).toMatchObject({
    count: 2_000_000_000, mean: 0.5, precision: { kind: 'exact-rational', numerator: '1', denominator: '2' } });
  expect(() => reduceStandingCounts(100, new Map([[5, 101]]), { min: 1, max: 5 })).toThrow();
});
