import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SparqlResult } from '../src/infrastructure/fuseki.ts';
import type { RatingAggregateInventory } from '../src/modules/access/rating-aggregate-inventory.ts';
import { InvalidRatingAggregateQuery, RatingAggregateBudgetExceeded, RatingAggregateUnavailable }
  from '../src/modules/rating/aggregate.ts';
import { InvalidRatingContextInput, RATING_ACCOUNT_POPULATION, RATING_LATEST_MEAN_POLICY,
  RATING_STANDING_CADENCE, REALM_STANDING_RATING_CONTEXT_PROFILE } from '../src/modules/rating/context.ts';
import { GLOBAL_CONTEXT_PROFILE, GLOBAL_OBSERVATION_PROFILE, GLOBAL_RATING_POPULATION,
  GLOBAL_RATING_POPULATION_OWNER, globalRatingContextDigest, globalRatingDigest } from '../src/modules/rating/global.ts';
import { queryGlobalRatingAggregate, queryRealmGlobalSynthesis, standingComponentsQuery }
  from '../src/modules/rating/global-aggregate.ts';
import { InvalidRatingObservationInput, STANDING_RATING_OBSERVATION_PROFILE, standingRatingDigest }
  from '../src/modules/rating/observation.ts';
import { reduceStandingComponent, synthesizeRealmGlobal } from '../src/modules/rating/synthesis.ts';
import { prepareComponent, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const id = (n: number) => `https://rezics.com/id/019cb49e-0ea2-7000-8000-${String(n).padStart(12, '0')}`;
const REALM = id(1), REALM_CONTEXT = id(2), GLOBAL_CONTEXT = id(3), WORK = id(4), MAIN = id(5), ACTOR = id(6);
const RV = 'https://rezics.com/vocab/';
const uri = (value: string) => ({ type: 'uri', value });
const text = (value: string) => ({ type: 'literal', value });

interface Fixture {
  env: WorkActivationEnvironment; access: FakeAccess; graph: FakeGraph;
  rows: { realm: Row[]; global: Row[] }; inventories: Record<string, RatingAggregateInventory>;
  close: () => void;
}
type Row = NonNullable<SparqlResult['results']>['bindings'][number];

class FakeGraph {
  calls = 0; queries: string[] = []; rows: Row[] = [];
  async query(sparql: string) { this.calls++; this.queries.push(sparql); return { results: { bindings: this.rows } }; }
}
class FakeAccess {
  inventoryCalls = 0; fenceCalls = 0; fenceOpen = true;
  constructor(private readonly inventories: Record<string, RatingAggregateInventory>) {}
  async readRatingAggregateInventory(context: string) {
    this.inventoryCalls++;
    const inventory = this.inventories[context];
    if (!inventory) throw new Error('Rating inventory is unavailable');
    return structuredClone(inventory);
  }
  async checkRatingAggregateFence(generation: string) { this.fenceCalls++; return this.fenceOpen && generation === '7'; }
}

/** A sealed owner snapshot: immutable manifests on disk, Access heads and matching graph rows. */
function fixture(realmValues: (number | null)[], globalValues: (number | null)[]): Fixture {
  const directory = mkdtempSync(join(tmpdir(), 'rating-global-'));
  const env = { fuseki: new FakeGraph(), lineage: { dataEpoch: 'epoch-1', routingEpoch: '1' },
    objectDirectory: directory } as unknown as WorkActivationEnvironment;
  const graph = env.fuseki as unknown as FakeGraph;
  let next = 100;
  const inventories: Record<string, RatingAggregateInventory> = {};
  const rows = { realm: [] as Row[], global: [] as Row[] };
  for (const kind of ['realm', 'global'] as const) {
    const context = kind === 'realm' ? REALM_CONTEXT : GLOBAL_CONTEXT;
    const owner = kind === 'realm' ? REALM : GLOBAL_RATING_POPULATION_OWNER;
    const contextRevision = id(next++), question = `${kind} quality`;
    const contextManifest = prepareComponent(directory, context, kind === 'realm'
      ? { context, realm: REALM, question, state: 'active', targetGrain: 'MainVersion', scaleMin: 1, scaleMax: 10,
        cadence: RATING_STANDING_CADENCE, populationPolicy: RATING_ACCOUNT_POPULATION,
        aggregationPolicy: RATING_LATEST_MEAN_POLICY }
      : { context, populationOwner: owner, question, state: 'active', targetGrain: 'MainVersion', scaleMin: 1,
        scaleMax: 5, cadence: RATING_STANDING_CADENCE, populationPolicy: GLOBAL_RATING_POPULATION,
        aggregationPolicy: RATING_LATEST_MEAN_POLICY },
    kind === 'realm' ? REALM_STANDING_RATING_CONTEXT_PROFILE : GLOBAL_CONTEXT_PROFILE);
    const inventory: RatingAggregateInventory = { realm: owner, contextRevision, policyRevision: contextRevision,
      recoveryGeneration: '7', contextReceipt: `urn:rezics:receipt:${kind}`, contextDataEpoch: 'epoch-1',
      contextSequence: '1', heads: [] };
    rows[kind].push({ kind: text('context'), component: text(kind), epoch: text('epoch-1'), sequence: text('50'),
      owner: uri(owner), contextRevision: uri(contextRevision), contextManifest: uri(`urn:rezics:sha256:${contextManifest}`),
      question: { type: 'literal', value: question, 'xml:lang': 'en' }, contextEpoch: text('epoch-1'),
      contextSequence: text('1'), receipt: uri(inventory.contextReceipt) });
    for (const [index, value] of (kind === 'realm' ? realmValues : globalValues).entries()) {
      const observation = id(next++), revision = id(next++), slot = `urn:rezics:rating-slot:${String(next).padStart(64, '0')}`;
      const time = `2026-09-27T00:00:0${index}.000Z`;
      const intent = { context, work: WORK, mainVersion: MAIN, value, expectedRevisionHead: null, actingSubject: ACTOR };
      const digest = kind === 'realm' ? standingRatingDigest(value === null ? { ...intent, expectedRevisionHead: id(99) } : intent)
        : globalRatingDigest(value === null ? { ...intent, expectedRevisionHead: id(99) } : intent);
      const predecessor = value === null ? id(99) : null;
      const manifest = prepareComponent(directory, observation, { observation, slot, context, contextRevision,
        ...(kind === 'realm' ? { realm: owner } : { populationOwner: owner }), work: WORK, mainVersion: MAIN,
        revision, predecessor, availability: value === null ? 'withdrawn' : 'available', value,
        evaluatedAt: time, submittedAt: time, originalSubmissionAt: time, revisedAt: time },
      kind === 'realm' ? STANDING_RATING_OBSERVATION_PROFILE : GLOBAL_OBSERVATION_PROFILE);
      const receipt = `urn:rezics:receipt:${kind}-${index}`;
      inventory.heads.push({ slot, work: WORK, observation, revision, raterKey: `${kind}-${index}`,
        evaluatedAt: time, submittedAt: time, actingSubject: ACTOR, requestDigest: digest, receipt,
        dataEpoch: 'epoch-1', sequence: String(2 + index) });
      rows[kind].push({ kind: text('observation'), component: text(kind), epoch: text('epoch-1'), sequence: text('50'),
        observation: uri(observation), slot: uri(slot), head: uri(revision),
        availability: uri(`${RV}${value === null ? 'Withdrawn' : 'Available'}`),
        ...(value === null ? {} : { value: text(String(value)) }), manifest: uri(`urn:rezics:sha256:${manifest}`),
        evaluatedAt: text(time), submittedAt: text(time), originalSubmissionAt: text(time), revisedAt: text(time),
        revisionEpoch: text('epoch-1'), revisionSequence: text(String(2 + index)), receipt: uri(receipt),
        digest: text(digest), ...(predecessor ? { predecessor: uri(predecessor) } : {}) });
    }
    inventories[context] = inventory;
  }
  graph.rows = [...rows.realm, ...rows.global];
  return { env, access: new FakeAccess(inventories), graph, rows, inventories,
    close: () => rmSync(directory, { recursive: true, force: true }) };
}
const synthesis = (f: Fixture, realmContext = REALM_CONTEXT, globalContext = GLOBAL_CONTEXT) =>
  queryRealmGlobalSynthesis(f.env, f.access, { realmContext, globalContext, work: WORK, mainVersion: MAIN });

test('RATE06: synthesis keeps Realm and Global components separate and returns 17/24, never the pooled 5.2', async () => {
  const f = fixture([8, 6], [5, 3, 4]);
  try {
    const result = await synthesis(f);
    expect(result).toMatchObject({ profile: 'realm-global-standing-synthesis-v1', status: 'complete', missing: [],
      value: { numerator: '17', denominator: '24' },
      policy: { normalization: 'scale-min-max-unit-interval', weighting: 'equal-context', raterPooling: 'none' },
      sourcePosition: { datasetId: 'product', dataEpoch: 'epoch-1', sequence: '50' } });
    expect(result.numericValue).toBeCloseTo(17 / 24, 12);
    expect(result.components.realm).toMatchObject({ context: REALM_CONTEXT, populationOwner: REALM,
      contextProfile: 'realm-standing-rating-context-v1', populationPolicy: 'account-principal',
      scale: { min: 1, max: 10, step: 1 }, population: 2, count: 2, sum: 14, mean: 7,
      precision: { kind: 'exact-rational', numerator: '7', denominator: '1' }, unitMean: { numerator: '2', denominator: '3' },
      histogram: [0, 0, 0, 0, 0, 1, 0, 1, 0, 0] });
    expect(result.components.global).toMatchObject({ context: GLOBAL_CONTEXT, populationOwner: GLOBAL_RATING_POPULATION_OWNER,
      contextProfile: 'global-rating-standing-context-v1', populationPolicy: 'global-account-principal',
      scale: { min: 1, max: 5, step: 1 }, population: 3, count: 3, sum: 12, mean: 4,
      unitMean: { numerator: '3', denominator: '4' }, histogram: [0, 0, 1, 1, 1] });
    // No pooled population, count or 26/5 mean exists anywhere in the response.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('5.2');
    expect(serialized).not.toContain('"26"');
    expect(result.components.realm.count + result.components.global.count).toBe(5);
    expect(Object.keys(result)).not.toContain('count');
    // One owner snapshot per Context, one graph query for both, one final fence check.
    expect({ graph: f.graph.calls, inventory: f.access.inventoryCalls, fence: f.access.fenceCalls })
      .toEqual({ graph: 1, inventory: 2, fence: 1 });
    f.graph.rows = f.rows.global;
    const global = await queryGlobalRatingAggregate(f.env, f.access, { context: GLOBAL_CONTEXT, work: WORK, mainVersion: MAIN });
    expect(global).toMatchObject({ profile: 'global-rating-standing-latest-mean-v1', complete: true, mean: 4,
      precision: { kind: 'exact-rational', numerator: '4', denominator: '1' } });
  } finally { f.close(); }
});

test('RATE06: exact unit means and equal Context weight, independent of population size', () => {
  const realm = reduceStandingComponent([1, 10, 10], { min: 1, max: 10 });
  const global = reduceStandingComponent([1], { min: 1, max: 5 });
  expect(realm.unitMean).toEqual({ numerator: '2', denominator: '3' });
  expect(global.unitMean).toEqual({ numerator: '0', denominator: '1' });
  // A hundred Global raters do not outweigh one Realm Context.
  const crowd = reduceStandingComponent(Array.from({ length: 100 }, () => 5), { min: 1, max: 5 });
  expect(synthesizeRealmGlobal(realm, crowd).value).toEqual({ numerator: '5', denominator: '6' });
  expect(synthesizeRealmGlobal(realm, global).value).toEqual({ numerator: '1', denominator: '3' });
  expect(() => reduceStandingComponent([6], { min: 1, max: 5 })).toThrow(RangeError);
  expect(() => reduceStandingComponent([0], { min: 1, max: 10 })).toThrow(RangeError);
});

test('RATE06: a missing component makes the synthesis partial without falling back to the other side', async () => {
  const f = fixture([8, 6], [null]);
  try {
    const result = await synthesis(f);
    expect(result).toMatchObject({ status: 'partial', missing: ['global'], value: null, numericValue: null });
    expect(result.components.global).toMatchObject({ population: 1, count: 0, withdrawnCount: 1, mean: null,
      precision: { kind: 'no-data' }, unitMean: null });
    expect(result.components.realm).toMatchObject({ count: 2, mean: 7 });
  } finally { f.close(); }
  const empty = fixture([], []);
  try {
    expect(await synthesis(empty)).toMatchObject({ status: 'partial', missing: ['realm', 'global'], value: null });
  } finally { empty.close(); }
});

test('RATE06: Global requests keep their own scale, question and digest family', () => {
  const intent = { context: GLOBAL_CONTEXT, work: WORK, mainVersion: MAIN, expectedRevisionHead: null, actingSubject: ACTOR };
  expect(() => globalRatingDigest({ ...intent, value: 6 })).toThrow(InvalidRatingObservationInput);
  expect(() => globalRatingDigest({ ...intent, value: 0 })).toThrow(InvalidRatingObservationInput);
  expect(() => globalRatingDigest({ ...intent, value: null })).toThrow(InvalidRatingObservationInput);
  // The same intent on the Realm family is another request, never an alias.
  expect(globalRatingDigest({ ...intent, value: 5 })).not.toBe(standingRatingDigest({ ...intent, value: 5 }));
  expect(() => globalRatingContextDigest({ question: ' padded', actingSubject: ACTOR })).toThrow(InvalidRatingContextInput);
  expect(() => globalRatingContextDigest({ question: 'ok', actingSubject: ACTOR })).toThrow(InvalidRatingContextInput);
  expect(globalRatingContextDigest({ question: 'Overall quality', actingSubject: ACTOR })).toMatch(/^[0-9a-f]{64}$/);
});

test('RATE06: stale, unsealed, damaged or fenced evidence makes the synthesis unavailable, never smaller', async () => {
  const cases: [string, (f: Fixture) => void][] = [
    ['graph head differs from the sealed inventory', f => { f.rows.global[1]!.head = uri(id(900)); }],
    ['graph lost a sealed slot', f => { f.graph.rows = f.graph.rows.filter(row => row !== f.rows.global[2]); }],
    ['unsealed graph effect', f => { f.inventories[GLOBAL_CONTEXT]!.heads.pop(); }],
    ['head sealed after the graph position', f => { f.inventories[REALM_CONTEXT]!.heads[0]!.sequence = '51';
      f.rows.realm[1]!.revisionSequence = text('51'); }],
    ['Realm value outside its scale', f => { f.rows.realm[1]!.value = text('11'); }],
    ['Global value on the Realm scale', f => { f.rows.global[1]!.value = text('8'); }],
    ['request digest differs', f => { f.inventories[GLOBAL_CONTEXT]!.heads[0]!.requestDigest = '0'.repeat(64);
      f.rows.global[1]!.digest = text('0'.repeat(64)); }],
    ['missing manifest bytes', f => { f.rows.global[1]!.manifest = uri(`urn:rezics:sha256:${'f'.repeat(64)}`); }],
    ['Global evaluation time differs from Access', f => { f.inventories[GLOBAL_CONTEXT]!.heads[0]!.evaluatedAt = '2026-01-01T00:00:00.000Z'; }],
    ['rolled back Context receipt', f => { f.rows.realm[0]!.receipt = uri('urn:rezics:receipt:other'); }],
    ['recovery fence closed', f => { f.access.fenceOpen = false; }],
    ['mixed recovery generations', f => { f.inventories[GLOBAL_CONTEXT]!.recoveryGeneration = '8'; }],
    ['missing Context root', f => { f.graph.rows = f.graph.rows.filter(row => row !== f.rows.global[0]); }],
  ];
  for (const [name, damage] of cases) {
    const f = fixture([8, 6], [5, 3, 4]);
    try {
      damage(f);
      const outcome = await synthesis(f).then(() => 'complete', error => error.constructor.name);
      expect({ name, outcome }).toEqual({ name, outcome: RatingAggregateUnavailable.name });
    } finally { f.close(); }
  }
});

test('RATE06: swapped or duplicated Context kinds are rejected and oversized populations get a budget outcome', async () => {
  const f = fixture([8], [4]);
  try {
    await expect(synthesis(f, GLOBAL_CONTEXT, REALM_CONTEXT)).rejects.toBeInstanceOf(InvalidRatingAggregateQuery);
    await expect(synthesis(f, REALM_CONTEXT, REALM_CONTEXT)).rejects.toBeInstanceOf(InvalidRatingAggregateQuery);
    await expect(queryGlobalRatingAggregate(f.env, f.access, { context: REALM_CONTEXT, work: WORK, mainVersion: MAIN }))
      .rejects.toBeInstanceOf(InvalidRatingAggregateQuery);
    expect(f.graph.calls).toBe(0);
    const heads = f.inventories[GLOBAL_CONTEXT]!.heads;
    while (heads.length <= 100) heads.push({ ...heads[0]!, slot: `${heads[0]!.slot}${heads.length}` });
    await expect(synthesis(f)).rejects.toBeInstanceOf(RatingAggregateBudgetExceeded);
    expect(f.graph.calls).toBe(0);
  } finally { f.close(); }
});

test('RATE06: one bounded graph query covers both Contexts regardless of unrelated history', () => {
  const env = { lineage: { dataEpoch: 'epoch-1', routingEpoch: '1' } } as WorkActivationEnvironment;
  const both = standingComponentsQuery(env, [{ kind: 'realm', context: REALM_CONTEXT },
    { kind: 'global', context: GLOBAL_CONTEXT }], { work: WORK, mainVersion: MAIN });
  expect(both.match(/LIMIT 101 }/g)).toHaveLength(2);
  expect(both.trimEnd().endsWith('LIMIT 205')).toBe(true);
  // The Realm branch cannot read Global subjects and vice versa.
  expect(both).toContain('a rv:GlobalRatingObservation ;');
  expect(both).toContain('a rv:RatingObservation ;');
  expect(both).toContain(`rv:modelRevision <${GLOBAL_OBSERVATION_PROFILE}>`);
  expect(both).toContain(`rv:modelRevision <${STANDING_RATING_OBSERVATION_PROFILE}>`);
  expect(both).toContain('FILTER NOT EXISTS { <urn:rezics:dataset:product> rv:restoreHold true }');
  const global = standingComponentsQuery(env, [{ kind: 'global', context: GLOBAL_CONTEXT }], { work: WORK, mainVersion: MAIN });
  expect(global).not.toContain('rv:Realm ;');
  expect(global.trimEnd().endsWith('LIMIT 103')).toBe(true);
});
