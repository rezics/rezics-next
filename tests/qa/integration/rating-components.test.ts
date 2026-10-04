import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import { startRatingStack, type Person } from './rating-components-support.ts';

let r: Awaited<ReturnType<typeof startRatingStack>>;
beforeAll(async () => { r = await startRatingStack('rating-components'); }, 300_000);
afterAll(async () => { await r?.stop(); });

/** Runs `task` over `items` a few at a time so a large population stays inside the stack's connection budget. */
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
const sumRows = async (context: string) => (await r.stack.accessPool.query(`SELECT count(*)::int AS targets,
  sum(slots)::int AS slots, sum(unvalued)::int AS unvalued, sum(rating_count)::int AS count, sum(rating_sum)::int AS sum
  FROM access.target_rating_component WHERE context = $1`, [context])).rows[0] as
  { targets: number; slots: number; unvalued: number; count: number; sum: number };

test('components equal a recomputation from sealed heads after writes, changes, withdrawals, stale writes and concurrent writes', async () => {
  const context = (await r.context({ displayThreshold: 2 })).context;
  const [first, second] = [await r.resource('Asuna'), await r.resource('Yui')];
  const [a, b, c, d] = await raters('seal', 4) as [Person, Person, Person, Person];
  const check = async (target: string) => {
    await r.expectComponentsMatchHeads(context, target);
    const { row } = await r.components(context, target);
    const read = await r.aggregate(context, target);
    // The API answers from those components, and their count and sum are what the histogram says.
    expect({ count: read.count, population: read.population, sum: read.sum, histogram: read.histogram })
      .toEqual({ count: row.count, population: row.slots, sum: row.sum, histogram: row.histogram });
    const totals = await r.contextTotals(context), summed = await sumRows(context);
    expect(totals).toMatchObject({ targets: summed.targets, slots: summed.slots, unvalued: summed.unvalued, count: summed.count, sum: summed.sum });
    const histogram = (await r.stack.accessPool.query(`SELECT h.value, count(*)::int AS n FROM access.target_rating_head h
      WHERE h.context = $1 AND h.value IS NOT NULL GROUP BY h.value`, [context])).rows as { value: number; n: number }[];
    expect(totals!.histogram).toEqual(Array.from({ length: 10 }, (_, index) => histogram.find(bin => bin.value === index + 1)?.n ?? 0));
    return read;
  };
  expect(await r.components(context, first)).toEqual({ row: null, recomputed: { slots: 0, unvalued: 0, count: 0, sum: 0, histogram: Array(10).fill(0) } });
  const opinions = new Map<string, { observationRevision: string }>();
  for (const [rater, value] of [[a, 8], [b, 6], [c, 10], [d, 3]] as const) opinions.set(rater.actor, await r.rate(rater, context, first, value));
  expect(await check(first)).toMatchObject({ count: 4, sum: 27 });
  // A rater's revision subtracts the value it replaces and adds the new one.
  opinions.set(a.actor, await r.rate(a, context, first, 9, opinions.get(a.actor)!.observationRevision));
  expect(await check(first)).toMatchObject({ count: 4, sum: 28 });
  // A revision to the same value changes the head but not a figure.
  opinions.set(c.actor, await r.rate(c, context, first, 10, opinions.get(c.actor)!.observationRevision));
  expect(await check(first)).toMatchObject({ count: 4, sum: 28 });
  // Withdrawal subtracts only, leaves the head, and a withdrawn rater may rate again.
  opinions.set(b.actor, await r.rate(b, context, first, null, opinions.get(b.actor)!.observationRevision));
  expect(await check(first)).toMatchObject({ count: 3, population: 4, withdrawnCount: 1, sum: 22 });
  opinions.set(b.actor, await r.rate(b, context, first, 4, opinions.get(b.actor)!.observationRevision));
  expect(await check(first)).toMatchObject({ count: 4, population: 4, withdrawnCount: 0, sum: 26 });
  // A stale revision is refused before the seal and moves nothing.
  const before = (await r.components(context, first)).row;
  expect((await r.call(a, 'POST', '/v1/rating-observations', { profile: 'realm-target-rating-observation-v1', context,
    target: first, value: 1, expectedRevisionHead: null, actingSubject: a.actor })).status).toBe(409);
  expect((await r.components(context, first)).row).toEqual(before);
  // Another target of the Context keeps its own components and adds to the Context's.
  await r.rate(a, context, second, 5);
  await r.rate(b, context, second, 7);
  expect(await check(second)).toMatchObject({ count: 2, sum: 12 });
  await check(first);

  // Concurrent writes: new raters in parallel, and one rater racing two revisions of the same head.
  const crowd = await raters('seal-crowd', 12);
  const racing = opinions.get(d.actor)!.observationRevision;
  const results = await Promise.all([...crowd.map((rater, index) => r.rate(rater, context, first, (index % 10) + 1)
    .then(() => 201)), ...[2, 9].map(value => r.call(d, 'POST', '/v1/rating-observations', {
    profile: 'realm-target-rating-observation-v1', context, target: first, value, expectedRevisionHead: racing,
    actingSubject: d.actor }).then(response => response.status))]);
  expect(results.slice(0, 12).every(status => status === 201)).toBe(true);
  expect(results.slice(12).sort()).toEqual([201, 409]);
  const settled = await check(first);
  expect(settled).toMatchObject({ population: 16, count: 16 });
  // Every rating in the histogram came from exactly one sealed head.
  expect(settled.histogram.reduce((total, n) => total + n, 0)).toBe(16);
}, 300_000);

test('a target rated by more than 100 principals aggregates from its components, and a missing last write makes it unavailable', async () => {
  const context = (await r.context()).context;
  const target = await r.resource('Kirito');
  const crowd = await raters('crowd', 130);
  const heads = new Map<string, { observationRevision: string }>();
  const aggregates = new Map<number, Awaited<ReturnType<typeof r.aggregate>>>();
  await inBatches(crowd.slice(0, 100), 10, async (rater, index) => heads.set(rater.actor, await r.rate(rater, context, target, (index % 10) + 1)));
  aggregates.set(100, await r.aggregate(context, target));
  await r.rate(crowd[100]!, context, target, 10);
  aggregates.set(101, await r.aggregate(context, target));
  await inBatches(crowd.slice(101), 10, async (rater, index) => heads.set(rater.actor, await r.rate(rater, context, target, ((index + 101) % 10) + 1)));
  aggregates.set(130, await r.aggregate(context, target));
  // Up to 100 raters the heads are verified one by one; past it only the components answer. Both agree.
  expect(aggregates.get(100)).toMatchObject({ count: 100, population: 100, sum: 550, mean: 5.5, meanDisplay: 'shown' });
  expect(aggregates.get(100)!.histogram).toEqual(Array(10).fill(10));
  expect(aggregates.get(101)).toMatchObject({ count: 101, population: 101, sum: 560, meanDisplay: 'shown' });
  expect(aggregates.get(130)).toMatchObject({ count: 130, population: 130, withdrawnCount: 0, meanDisplay: 'shown', displayThreshold: 5 });
  await r.expectComponentsMatchHeads(context, target);
  const settled = (await r.components(context, target)).row!;
  expect(settled).toMatchObject({ slots: 130, count: 130 });
  expect(aggregates.get(130)).toMatchObject({ sum: settled.sum, histogram: settled.histogram });
  // Changes and withdrawals stay additive at this size.
  await r.rate(crowd[0]!, context, target, 10, heads.get(crowd[0]!.actor)!.observationRevision);
  await r.rate(crowd[1]!, context, target, null, heads.get(crowd[1]!.actor)!.observationRevision);
  const moved = await r.aggregate(context, target);
  expect(moved).toMatchObject({ count: 129, population: 130, withdrawnCount: 1, sum: settled.sum + 9 - 2 });
  await r.expectComponentsMatchHeads(context, target);

  // Unavailable, never wrong: a graph that lost the last sealed write cannot match the sealed receipt.
  const rows = (await r.stack.fuseki.query(`PREFIX rv: <${RV}> SELECT ?observation ?head WHERE { GRAPH ${iri(GRAPHS.current)} {
    ?observation rv:ratingContext ${iri(context)} ; rv:target ${iri(target)} ; rv:observationHead ?head } }`)).results!.bindings;
  expect(rows).toHaveLength(130);
  const lastRevision = (await r.stack.accessPool.query(`SELECT h.observation, h.revision FROM access.target_rating_component k
    JOIN access.target_rating_head h ON h.admission_id = k.last_admission_id WHERE k.context = $1 AND k.target = $2`, [context, target])).rows[0] as
    { observation: string; revision: string };
  const drop = `PREFIX rv: <${RV}> DELETE DATA { GRAPH ${iri(GRAPHS.current)} { ${iri(lastRevision.observation)} rv:observationHead ${iri(lastRevision.revision)} } }`;
  await r.stack.fuseki.update(drop);
  expect(await r.json(await r.call(r.owner, 'POST', '/v1/rating-aggregates', { profile: 'realm-target-latest-mean-v1', context, target,
    actingSubject: r.owner.actor }), 503)).toMatchObject({ code: 'rating_aggregate_unavailable' });
  await r.stack.fuseki.update(drop.replace('DELETE DATA', 'INSERT DATA'));
  expect(await r.aggregate(context, target)).toMatchObject({ count: 129 });
}, 480_000);

test('a component that no longer equals its heads makes a verifiable target unavailable instead of wrong', async () => {
  const context = (await r.context()).context;
  const target = await r.resource('Sinon');
  const [a, b] = await raters('drift', 2) as [Person, Person];
  await r.rate(a, context, target, 4);
  await r.rate(b, context, target, 6);
  expect(await r.aggregate(context, target)).toMatchObject({ count: 2, sum: 10 });
  // Move one rating between bins consistently, as a partial restore of one owner might.
  await r.stack.accessPool.query(`UPDATE access.target_rating_component SET histogram = ARRAY[0,0,0,0,0,2,0,0,0,0], rating_sum = 12
    WHERE context = $1 AND target = $2`, [context, target]);
  expect(await r.json(await r.call(r.owner, 'POST', '/v1/rating-aggregates', { profile: 'realm-target-latest-mean-v1', context, target,
    actingSubject: r.owner.actor }), 503)).toMatchObject({ code: 'rating_aggregate_unavailable' });
  // The database itself refuses a row whose sum or count is not what its histogram says.
  await expect(r.stack.accessPool.query(`UPDATE access.target_rating_component SET rating_sum = rating_sum + 1
    WHERE context = $1 AND target = $2`, [context, target])).rejects.toMatchObject({ code: '23514' });
  await r.stack.accessPool.query(`UPDATE access.target_rating_component SET histogram = ARRAY[0,0,0,1,0,1,0,0,0,0], rating_sum = 10
    WHERE context = $1 AND target = $2`, [context, target]);
  expect(await r.aggregate(context, target)).toMatchObject({ count: 2, sum: 10 });
}, 300_000);

test('heads sealed before components existed are counted unvalued, read from verified heads and then recorded', async () => {
  const context = (await r.context({ displayThreshold: 1 })).context;
  const target = await r.resource('Leafa');
  const [a, b, c] = await raters('legacy', 3) as [Person, Person, Person];
  const opinions = new Map<string, { observationRevision: string }>();
  for (const [rater, value] of [[a, 7], [b, 9], [c, 2]] as const) opinions.set(rater.actor, await r.rate(rater, context, target, value));
  // Return Access to its state before the migration: heads without values, no component rows.
  await r.stack.accessPool.query('UPDATE access.target_rating_head SET value = NULL, value_known = false WHERE context = $1', [context]);
  await r.stack.accessPool.query('DELETE FROM access.target_rating_component WHERE context = $1', [context]);
  await r.stack.accessPool.query('DELETE FROM access.target_rating_context_component WHERE context = $1', [context]);
  const migration = readFileSync(new URL('../../../services/main/migrations/access/1055_target_rating_components.sql', import.meta.url), 'utf8');
  const statement = (table: string) => migration.match(new RegExp(`INSERT INTO access\\.${table}\\b[\\s\\S]*?;`))![0];
  // The migration's own backfill statements, restricted to the Context under test: every head is counted and none has a value.
  const restricted = (sql: string, from: string, to: string) => {
    expect(sql).toContain(from);
    return sql.replace(from, to);
  };
  await r.stack.accessPool.query(restricted(statement('target_rating_component'), 'ON a.id = h.admission_id',
    `ON a.id = h.admission_id AND h.context = '${context}'`));
  await r.stack.accessPool.query(restricted(statement('target_rating_context_component'), 'FROM access.target_rating_component GROUP BY context',
    `FROM access.target_rating_component WHERE context = '${context}' GROUP BY context`));
  expect((await r.components(context, target)).row).toEqual({ slots: 3, unvalued: 3, count: 0, sum: 0, histogram: Array(10).fill(0) });
  expect(await r.contextTotals(context)).toMatchObject({ targets: 1, slots: 3, unvalued: 3, count: 0, sum: 0 });
  // The first verified read answers from the heads' own bytes and records what it learned.
  expect(await r.aggregate(context, target)).toMatchObject({ count: 3, population: 3, sum: 18, mean: 6 });
  expect((await r.components(context, target)).row).toEqual({ slots: 3, unvalued: 0, count: 3, sum: 18, histogram: [0, 1, 0, 0, 0, 0, 1, 0, 1, 0] });
  expect(await r.contextTotals(context)).toMatchObject({ targets: 1, slots: 3, unvalued: 0, count: 3, sum: 18 });
  await r.expectComponentsMatchHeads(context, target);

  // A rater whose head is still unvalued subtracts nothing when revising: only the new value enters.
  await r.stack.accessPool.query(`UPDATE access.target_rating_head SET value = NULL, value_known = false
    WHERE context = $1 AND principal_id = $2`, [context, b.principalId]);
  await r.stack.accessPool.query(`UPDATE access.target_rating_component SET unvalued = 1, rating_count = 2, rating_sum = 9,
    histogram = ARRAY[0,1,0,0,0,0,1,0,0,0] WHERE context = $1 AND target = $2`, [context, target]);
  await r.stack.accessPool.query(`UPDATE access.target_rating_context_component SET unvalued = 1, rating_count = 2, rating_sum = 9,
    histogram = ARRAY[0,1,0,0,0,0,1,0,0,0] WHERE context = $1`, [context]);
  await r.rate(b, context, target, 5, opinions.get(b.actor)!.observationRevision);
  expect((await r.components(context, target)).row).toEqual({ slots: 3, unvalued: 0, count: 3, sum: 14, histogram: [0, 1, 0, 0, 1, 0, 1, 0, 0, 0] });
  await r.expectComponentsMatchHeads(context, target);
  expect(await r.aggregate(context, target)).toMatchObject({ count: 3, sum: 14 });
}, 300_000);
