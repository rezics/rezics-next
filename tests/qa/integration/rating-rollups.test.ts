// sql-relations-allow: access.target_rating_context_component -- Migration 1080 drops these totals; the test proves they are gone.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { ROLLUP_COST } from '../../../services/main/src/modules/rating/rollup-read.ts';
import { DATASET, GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import { startRatingStack, type Person } from './rating-components-support.ts';

let r: Awaited<ReturnType<typeof startRatingStack>>;
beforeAll(async () => { r = await startRatingStack('rating-rollups'); }, 300_000);
afterAll(async () => { await r?.stop(); });

interface Member { target: string; status: string; reason?: string; mean?: number | null; meanDisplay?: string; meetsThreshold?: boolean;
  lastAdmissionId?: string | null;
  components?: { population: number; count: number; withdrawnCount: number; sum: number; histogram: number[] } }
interface Rollup { profile: string; context: string; formula: string; displayThreshold: number; memberCount: number;
  coverage: { members: number; available: number; meetingThreshold: number }; value: number | null; valueWithheld: string | null;
  members: Member[]; scale: { min: number; max: number }; scope: { grain: string; question: string };
  rank: null | { formula: string; minimumRatings: number; status: string; prior: { mean: number; weight: number } | null;
    items: { position: number; target: string; count: number; mean: number; score: number }[] } }

const rollup = (body: Record<string, unknown>, status = 200, reader: Person | null = r.owner) =>
  r.call(reader, 'POST', '/v1/rating-rollups', { profile: 'rating-rollup-v1', actingSubject: reader?.actor, ...body })
    .then(response => r.json<Rollup>(response, status));
async function inBatches<T>(items: readonly T[], size: number, task: (item: T, index: number) => Promise<unknown>) {
  for (let start = 0; start < items.length; start += size) {
    await Promise.all(items.slice(start, start + size).map((item, offset) => task(item, start + offset)));
  }
}
async function raters(prefix: string, count: number) {
  const made: Person[] = [];
  await inBatches(Array.from({ length: count }, (_, index) => index), 10, async index => { made[index] = await r.person(`${prefix}-${index}`); });
  return made;
}
/** `ratings` raters give `target` the values in `values` in turn, so its mean is known exactly. */
const fill = (context: string, target: string, people: readonly Person[], ratings: number, values: readonly number[]) =>
  inBatches(people.slice(0, ratings), 10, (rater, index) => r.rate(rater, context, target, values[index % values.length]!));
const sequence = async () => (await r.stack.fuseki.query(`PREFIX rv: <${RV}> SELECT ?sequence WHERE { GRAPH ${iri(GRAPHS.control)} {
  ${iri(DATASET)} rv:sequence ?sequence } }`)).results!.bindings[0]!.sequence!.value;

test("pooled and mean-of-means rank the same two roll-ups in opposite order, with coverage and every member's components", async () => {
  const context = (await r.context({ displayThreshold: 5 })).context;
  const [x1, x2, y1, y2, z] = await Promise.all(['x1', 'x2', 'y1', 'y2', 'z'].map(name => r.resource(name))) as [string, string, string, string, string];
  const people = await raters('rollup', 20);
  // X: one large kind member and one small harsh one. Y: two even members.
  await fill(context, x1, people, 20, [7, 9]);
  await fill(context, x2, people, 5, [3]);
  await fill(context, y1, people, 5, [6]);
  await fill(context, y2, people, 5, [6]);
  await fill(context, z, people, 3, [10]);

  const admissions = Number((await r.stack.accessPool.query('SELECT count(*) FROM access.admission')).rows[0].count), before = await sequence();
  const xPooled = await rollup({ context, targets: [x1, x2], formula: 'pooled' });
  const xMeans = await rollup({ context, targets: [x1, x2], formula: 'mean-of-means' });
  const yPooled = await rollup({ context, targets: [y1, y2], formula: 'pooled' });
  const yMeans = await rollup({ context, targets: [y1, y2], formula: 'mean-of-means' });
  expect([xPooled.value, yPooled.value]).toEqual([7, 6]);
  expect([xMeans.value, yMeans.value]).toEqual([5.5, 6]);
  expect(xPooled.value! > yPooled.value!).toBe(true);
  expect(xMeans.value! < yMeans.value!).toBe(true);
  // The formula, member count, coverage and each member's components come back with the value.
  expect(xPooled).toMatchObject({ profile: 'rating-rollup-v1', formula: 'pooled', displayThreshold: 5, memberCount: 2,
    coverage: { members: 2, available: 2, meetingThreshold: 2 }, valueWithheld: null, rank: null,
    scale: { min: 1, max: 10 }, scope: { grain: 'resource' } });
  expect(xPooled.members.map(({ lastAdmissionId: _, ...member }) => member)).toEqual([
    { target: x1, status: 'available', components: { population: 20, count: 20, withdrawnCount: 0, sum: 160,
      histogram: [0, 0, 0, 0, 0, 0, 10, 0, 10, 0] }, mean: 8, meanDisplay: 'shown', meetsThreshold: true },
    { target: x2, status: 'available', components: { population: 5, count: 5, withdrawnCount: 0, sum: 15,
      histogram: [0, 0, 5, 0, 0, 0, 0, 0, 0, 0] }, mean: 3, meanDisplay: 'shown', meetsThreshold: true }]);
  expect(xMeans.members).toEqual(xPooled.members);
  // A member under the threshold shows no mean of its own and is pooled but not averaged in.
  const withSmall = await rollup({ context, targets: [x1, x2, z], formula: 'pooled' });
  expect(withSmall.members[2]).toMatchObject({ target: z, mean: null, meanDisplay: 'withheld-below-threshold', meetsThreshold: false,
    components: { count: 3, sum: 30 } });
  expect(withSmall).toMatchObject({ coverage: { members: 3, available: 3, meetingThreshold: 2 }, value: (160 + 15 + 30) / 28 });
  expect((await rollup({ context, targets: [x1, x2, z], formula: 'mean-of-means' })).value).toBe(5.5);
  // Nothing is stored: a roll-up writes no admission and moves no graph position.
  expect(Number((await r.stack.accessPool.query('SELECT count(*) FROM access.admission')).rows[0].count)).toBe(admissions);
  expect(await sequence()).toBe(before);
}, 300_000);

test('members the caller cannot read, that do not exist or are another grain are reported, and lower coverage', async () => {
  const context = (await r.context({ displayThreshold: 2 })).context;
  const [a, b] = [await r.resource('a'), await r.resource('b')];
  const people = await raters('coverage', 3);
  await fill(context, a, people, 3, [8]);
  await fill(context, b, people, 3, [6]);
  const missing = `https://rezics.com/id/${randomUUID()}`;
  const work = await r.stack.publicWork(r.owner.actor);
  const hidden = await r.stack.privateWork(r.owner.actor);
  const named = [a, b, missing, work.work, hidden.work];
  const outsider = await r.person('outsider');
  // Without a grant the outsider reads none of the semantic members, and cannot tell a private or missing target from them.
  const found = await rollup({ context, targets: named, formula: 'pooled' }, 200, outsider);
  expect(found.members.map(member => [member.target, member.status, member.reason])).toEqual([
    [a, 'unavailable', 'unavailable'], [b, 'unavailable', 'unavailable'], [missing, 'unavailable', 'unavailable'],
    [work.work, 'unavailable', 'grain-mismatch'], [hidden.work, 'unavailable', 'unavailable']]);
  expect(found).toMatchObject({ memberCount: 5, value: null, valueWithheld: 'coverage-below-half',
    coverage: { members: 5, available: 0, meetingThreshold: 0 } });
  // Reading one member makes only that member available; the other is still named, not dropped.
  await outsider.grant(`semantic:read:${a}`, 'semantic.read');
  const partial = await rollup({ context, targets: [a, b], formula: 'pooled' }, 200, outsider);
  expect(partial.members.map(member => [member.target, member.status, member.reason])).toEqual([
    [a, 'available', undefined], [b, 'unavailable', 'unavailable']]);
  expect(partial).toMatchObject({ memberCount: 2, value: 8, coverage: { members: 2, available: 1, meetingThreshold: 1 } });
  const asOwner = await rollup({ context, targets: named, formula: 'pooled' });
  expect(asOwner.members.map(member => [member.status, member.reason])).toEqual([
    ['available', undefined], ['available', undefined], ['unavailable', 'unavailable'],
    ['unavailable', 'grain-mismatch'], ['unavailable', 'unavailable']]);
  // Two of five members meet the threshold: fewer than half, so the value is withheld, with its coverage.
  expect(asOwner).toMatchObject({ value: null, valueWithheld: 'coverage-below-half', memberCount: 5,
    coverage: { members: 5, available: 2, meetingThreshold: 2 } });
  const half = await rollup({ context, targets: [a, b, missing, work.work], formula: 'pooled' });
  expect(half).toMatchObject({ value: 7, valueWithheld: null, coverage: { members: 4, available: 2, meetingThreshold: 2 } });
  expect(half.members.filter(member => member.status === 'unavailable')).toHaveLength(2);
  // A member that exists but has no ratings is available with zero components, not unavailable.
  const unrated = await r.resource('unrated');
  expect((await rollup({ context, targets: [a, unrated], formula: 'pooled' })).members[1]).toMatchObject({ target: unrated,
    status: 'available', components: { population: 0, count: 0, sum: 0 }, mean: null, meanDisplay: 'no-data', meetsThreshold: false });
}, 300_000);

test('a v4 Character question reports a Work as not-accepted and computes the value from the accepted members only', async () => {
  const character = 'https://rezics.com/vocab/Character';
  const context = (await r.context({ profile: 'realm-target-rating-context-v4', displayThreshold: 2,
    question: `How much do you like this character? ${randomUUID().slice(0, 8)}`,
    acceptedSubjectTypes: [character] })).context;
  const liked = await r.resource('liked');
  const people = await raters('accept', 3);
  await fill(context, liked, people, 3, [8]);
  const [work, other, hidden] = await Promise.all([r.stack.publicWork(r.owner.actor), r.stack.publicWork(r.owner.actor), r.stack.privateWork(r.owner.actor)]);
  // Two Works would withhold the value if they stayed in the denominator (one of three is below half).
  const result = await rollup({ context, targets: [liked, work.work, other.work], formula: 'pooled', rank: true });
  expect(result.members.map(member => [member.target, member.status, member.reason])).toEqual([
    [liked, 'available', undefined], [work.work, 'not-accepted', undefined], [other.work, 'not-accepted', undefined]]);
  expect(result).toMatchObject({ memberCount: 3, value: 8, valueWithheld: null,
    coverage: { members: 1, available: 1, meetingThreshold: 1 } });
  expect(result.rank).toMatchObject({ status: 'ranked', items: [] });
  expect(result.members.filter(member => member.status === 'available').map(member => member.target)).toEqual([liked]);
  // A member the caller cannot read stays unavailable. Calling it not-accepted would disclose it.
  const outsider = await r.person('accept-outsider');
  const concealed = await rollup({ context, targets: [liked, hidden.work, work.work], formula: 'pooled' }, 200, outsider);
  expect(concealed.members.map(member => [member.target, member.status, member.reason])).toEqual([
    [liked, 'unavailable', 'unavailable'], [hidden.work, 'unavailable', 'unavailable'], [work.work, 'not-accepted', undefined]]);
  expect(concealed).toMatchObject({ value: null, valueWithheld: 'coverage-below-half',
    coverage: { members: 2, available: 0, meetingThreshold: 0 } });
}, 300_000);

test('a ranking weighs each member by a prior from its own RatingContext and lists only members of at least 50 ratings', async () => {
  const context = (await r.context({ displayThreshold: 5 })).context;
  const [big, steady, kind] = await Promise.all(['big', 'steady', 'kind'].map(name => r.resource(name))) as [string, string, string];
  const people = await raters('rank', 55);
  await fill(context, big, people, 55, [8, 9, 10]);
  await fill(context, steady, people, 50, [8]);
  await fill(context, kind, people, 20, [10]);
  const result = await rollup({ context, targets: [kind, steady, big], formula: 'pooled', rank: true });
  // The prior is this Context's pooled mean, weighted by its ratings per target but no lighter than the minimum.
  // `big` cycles 8, 9, 10 over 55 raters: eighteen full cycles and one more 8.
  const bigSum = 18 * 27 + 8, steadySum = 400, kindSum = 200, ratings = 55 + 50 + 20;
  expect((await r.components(context, big)).row!.sum).toBe(bigSum);
  expect(result.rank).toMatchObject({ formula: 'bayesian-weighted-rating', minimumRatings: 50, status: 'ranked',
    prior: { mean: (bigSum + steadySum + kindSum) / ratings, weight: 50}, });
  expect(Object.keys(result.rank!.prior!).sort()).toEqual(['mean', 'weight']);
  const prior = result.rank!.prior!;
  const weighted = (count: number, sum: number) => (count / (count + prior.weight)) * (sum / count) + (prior.weight / (count + prior.weight)) * prior.mean;
  // `kind` has the best mean but only 20 ratings, so it is not listed; the others are ordered by their weighted rating.
  expect(weighted(55, bigSum) > weighted(50, steadySum)).toBe(true);
  expect(result.rank!.items.map(item => item.target)).toEqual([big, steady]);
  expect(result.rank!.items[0]).toMatchObject({ position: 1, target: big, count: 55, mean: bigSum / 55 });
  expect(result.rank!.items[0]!.score).toBeCloseTo(weighted(55, bigSum), 10);
  expect(result.rank!.items[1]).toMatchObject({ position: 2, target: steady, count: 50, mean: 8 });
  expect(result.rank!.items[1]!.score).toBeCloseTo(weighted(50, steadySum), 10);
  expect(result.members.find(member => member.target === kind)).toMatchObject({ mean: 10, meetsThreshold: true });
  // Without `rank` the response carries no ranking; an empty Context has no prior to rank by.
  expect((await rollup({ context, targets: [kind], formula: 'pooled' })).rank).toBeNull();
  const empty = (await r.context()).context;
  expect((await rollup({ context: empty, targets: [kind, steady], formula: 'pooled', rank: true })).rank)
    .toMatchObject({ status: 'unavailable', prior: null, items: [] });
}, 480_000);

test('a roll-up costs the owners a fixed snapshot plus a bounded cost per member, and the same however many ratings its members hold', async () => {
  const context = (await r.context({ displayThreshold: 2 })).context;
  const members: string[] = [];
  await inBatches(Array.from({ length: 200 }, (_, index) => index), 5, async index => { members[index] = await r.resource(`member-${index}`); });
  const people = await raters('cost', 40);
  await fill(context, members[0]!, people, 12, [5, 6, 7]);
  const costs = new Map<number, { graph: number; access: number }>();
  for (const size of [1, 2, 64, 65, 130, 200]) {
    const { graph, access, result } = await r.measure(() => rollup({ context, targets: members.slice(0, size), formula: 'pooled' }));
    expect(result.members).toHaveLength(size);
    expect(result.members.every(member => member.status === 'available')).toBe(true);
    costs.set(size, { graph, access });
  }
  // Members are paid for by the shared target resolver: linear in their number, within its declared per-member bound.
  const declared = ROLLUP_COST.perMember;
  for (const [small, large] of [[1, 64], [64, 130], [130, 200]] as const) {
    const extra = large - small;
    expect(costs.get(large)!.graph - costs.get(small)!.graph).toBeLessThanOrEqual(declared.graphCalls * extra);
    expect(costs.get(large)!.access - costs.get(small)!.access).toBeLessThanOrEqual(declared.accessCheckouts * extra);
  }
  // This owner adds one snapshot and fence however many members: nothing beyond the per-member part is spent on ratings.
  const before = await r.measure(() => rollup({ context, targets: members.slice(0, 64), formula: 'pooled' }));
  await fill(context, members[0]!, people.slice(12), 28, [5, 6, 7, 8]);
  const after = await r.measure(() => rollup({ context, targets: members.slice(0, 64), formula: 'pooled' }));
  expect(after.result.members[0]).toMatchObject({ components: { count: 40 } });
  expect({ graph: after.graph, access: after.access }).toEqual({ graph: before.graph, access: before.access });
}, 600_000);

test('the prior uses only readable requested members, and unrelated writes leave roll-up evidence unchanged', async () => {
  const context = (await r.context({ displayThreshold: 2 })).context;
  const [visible, hidden] = [await r.resource('visible-prior'), await r.resource('hidden-prior')];
  const people = await raters('prior', 3) ;
  await fill(context, visible, people, 3,
    [8]); await fill(context, hidden, people, 3, [2]);
  const outsider = await r.person('prior-reader');
  await outsider.grant(`semantic:read:${visible}`, 'semantic.read');
  const input = { context, targets: [visible, hidden], formula: 'pooled', rank: true };
  const before = await rollup(input, 200, outsider) ;
  expect(before.rank!.prior).toEqual({ mean: 8, weight: 50 });
  expect(before.members[1]).toEqual({
    target: hidden,
    status: 'unavailable',
    reason: 'unavailable',
  });
  await r.rate(people[0]!, context, hidden, 10,
    (
      await r.stack.accessPool.query('SELECT revision FROM access.target_rating_head WHERE context = $1 AND target = $2 AND principal_id = $3',
        [context, hidden, people[0]!.principalId], )).rows[0] .revision,
  ); await r.resource('unrelated-sequence'); expect(await rollup(input, 200, outsider)).toEqual(before);
  // Removing the unused totals is forward-only; the migration left target components intact.
  expect(
    (
      await r.stack.accessPool.query(
        "SELECT to_regclass('access.target_rating_context_component') AS totals",
      )
    ).rows[0].totals,
  ).toBeNull();
}, 300_000);

test('a Context display threshold above 50 also withholds ranking means and scores', async () => {
  const context = (await r.context({ displayThreshold: 60 })).context;
  const target = await r.resource('high-threshold');
  const people = await raters('high-threshold', 60);
  await fill(context, target, people, 59, [9]);
  const input = { context, targets: [target], formula: 'pooled', rank: true };
  const before = await rollup(input);
  expect(before.members[0]).toMatchObject({ mean: null, meanDisplay: 'withheld-below-threshold' });
  expect(before.rank).toMatchObject({ minimumRatings: 60, items: [] });
  await r.rate(people[59]!, context, target,
    9);
  expect((await rollup(input)).rank).toMatchObject({ minimumRatings: 60, items: [{ target, count: 60, mean: 9 }],
  });
}, 480_000);

test('a roll-up combines one RatingContext only: other Contexts, stored means and malformed requests are refused', async () => {
  const context = (await r.context()).context, target = await r.resource('solo');
  const body = { context, targets: [target], formula: 'pooled' };
  for (const extra of [{ contexts: [context] }, { mean: 7 }, { formula: 'median' }, { targets: [] },
    { targets: [target, target] }, { targets: Array.from({ length: 201 }, () => `https://rezics.com/id/${randomUUID()}`) }]) {
    expect((await r.call(r.owner, 'POST', '/v1/rating-rollups', { profile: 'rating-rollup-v1', actingSubject: r.owner.actor,
      ...body, ...extra })).status).toBe(400);
  }
  // A Work Context is another grain and scale of question, never combined: it is not a roll-up Context.
  const workContext = await r.json<{ context: string }>(await r.call(r.owner, 'POST', '/v1/rating-contexts', {
    profile: 'realm-standing-rating-context-v1', realm: r.realm, question: 'Current quality', actingSubject: r.owner.actor }), 201);
  expect((await r.call(r.owner, 'POST', '/v1/rating-rollups', { profile: 'rating-rollup-v1', actingSubject: r.owner.actor,
    ...body, context: workContext.context })).status).toBe(404);
  expect((await r.call(r.owner, 'POST', '/v1/rating-rollups', { profile: 'rating-rollup-v1', actingSubject: r.owner.actor,
    ...body, context: `https://rezics.com/id/${randomUUID()}` })).status).toBe(404);
}, 300_000);
