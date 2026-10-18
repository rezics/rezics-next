import { expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Pool, type PoolClient } from 'pg';
import { boundedPool, NestedPoolCheckoutError, nestedPoolCheckoutMode, setNestedPoolCheckoutMode } from '../src/infrastructure/pg-pool.ts';
import { reservedTransactionPool } from '../src/infrastructure/pool-reservation.ts';
import { withAccessClient } from '../src/modules/access/topology-control.ts';
import { notificationReadPool } from '../src/modules/notification/request-budget.ts';
import { fenceStandingRatingTransition, refreshStandingRatingProjections } from '../src/modules/rating/standing-publication.ts';
import { ACCESS_RECOVERY_CLASSIFICATION, accessRecoveryRule, assertAccessRecoveryClassification } from '../src/modules/work/access-recovery-coverage.ts';
import type { OwnerTable } from '../src/modules/work/pg-recovery-frontier.ts';

const id = (n: number) => `https://rezics.com/id/019d0000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const context = id(1), origin = id(2), principal = '019d0000-0000-7000-8000-000000000003';
const task = 'editorial:019d0000-0000-7000-8000-000000000004:1';

/** External SQL transport for the publication protocol. Native trigger effects
 * and graph identity composition have separate, retained integration coverage;
 * this checks resumability, bounded dispatch and cancellation of the real owner. */
function transport(population: number) {
  const selections = Array.from({ length: population }, (_, index) => ({ main_version: id(100 + index), principal_id: principal }));
  const state = { after: selections[0]?.main_version ?? '', job: population > 1, transition: false,
    generation: 1, open: true, unsettled: false, loseCommit: false, checkouts: 0, refreshed: [] as string[], calls: [] as string[],
    candidateSizes: [] as number[], abortAfter: 0, cancellation: new AbortController(), releases: [] as boolean[] };
  let before: { after: string; job: boolean; transition: boolean; generation: number; refreshed: string[] } | null = null;
  const client = { release(destroy = false) { state.releases.push(destroy); }, async query(sql: string, values: unknown[] = []) {
    state.calls.push(sql);
    let rows: unknown[] = [];
    if (sql === 'BEGIN') before = { after: state.after, job: state.job, transition: state.transition,
      generation: state.generation, refreshed: [...state.refreshed] };
    else if (sql === 'COMMIT') {
      before = null;
      if (state.loseCommit) { state.loseCommit = false; throw new Error('lost response after commit'); }
    } else if (sql === 'ROLLBACK') { if (before) Object.assign(state, before); before = null; }
    else if (sql.startsWith('SET LOCAL')) { /* transaction control is counted */ }
    else if (sql.includes('FROM access.recovery_fence')) rows = [{ open: state.open, generation: '7' }];
    else if (sql.startsWith('INSERT INTO access.rating_standing_transition')) { state.transition = true; state.generation++; }
    else if (sql.includes('FROM access.rating_standing_refresh') && sql.includes('ORDER BY context')) {
      rows = state.job ? [{ context, origin_main_version: origin, origin_slot: 'urn:rezics:rating-slot:origin' }] : [];
    } else if (sql.includes('FROM access.scope_gate') || sql.includes('access.rating_observation_gate')) { /* gates */ }
    else if (sql.includes('FROM access.rating_standing_refresh') && sql.includes('FOR UPDATE')) {
      rows = state.job ? [{ after_main_version: state.after, after_principal_id: principal }] : [];
    } else if (sql.includes('FROM access.rating_merge_selection')) {
      rows = selections.filter(row => row.main_version > String(values[3])).slice(0, Number(values[5]));
      state.candidateSizes.push(rows.length);
    } else if (sql.startsWith('SELECT access.refresh_rating_standing_slot')) {
      state.refreshed.push(String(values[1]));
      if (state.abortAfter && state.refreshed.length === state.abortAfter) state.cancellation.abort();
    } else if (sql.startsWith('UPDATE access.rating_standing_refresh')) state.after = String(values[3]);
    else if (sql.startsWith('DELETE FROM access.rating_standing_refresh')) { state.job = false; state.generation++; }
    else if (sql === 'SELECT access.prune_rating_standing_changes()') { /* bounded maintenance, counted */ }
    else if (sql.includes('FROM access.rating_standing_publication() p')) rows = [{ pending: state.job || state.transition || state.unsettled ? '1' : '0',
      generation: String(state.generation), recovery_generation: '7', complete: !state.job }];
    else throw new Error(`Unexpected publication statement: ${sql}`);
    return { rows, rowCount: rows.length };
  } };
  const pool = { async connect() { state.checkouts++; return client; } } as unknown as Pool;
  return { state, pool, selections };
}

test('retained projection publication exhausts bounded pages without a population limit, including exact page exhaustion', async () => {
  for (const population of [0, 1, 100, 101, 102, 2048]) {
    const f = transport(population);
    let result;
    do {
      const start = f.state.calls.length;
      result = await refreshStandingRatingProjections(f.pool, { context, limit: 100 });
      expect(result.refreshed).toBeLessThanOrEqual(100);
      expect(f.state.calls.length - start).toBeLessThanOrEqual(114); // includes BEGIN, SET, COMMIT, gates and bounded pruning
      expect(result.publicationReady).toBe(result.complete);
    } while (!result.complete);
    expect(f.state.candidateSizes.every(size => size <= 101)).toBe(true);
    expect(f.state.refreshed).toEqual(f.selections.slice(1).map(row => row.main_version));
    expect(f.state.releases.every(destroy => !destroy)).toBe(true);
  }
});

test('lost responses resume committed progress and a newer source seal can rewind the retained frontier', async () => {
  const f = transport(12);
  f.state.loseCommit = true;
  await expect(refreshStandingRatingProjections(f.pool, { limit: 3 })).rejects.toThrow('lost response after commit');
  expect(f.state.after).toBe(f.selections[3]!.main_version);
  expect((await refreshStandingRatingProjections(f.pool, { limit: 3 })).refreshed).toBe(3);
  expect(f.state.refreshed).toEqual(f.selections.slice(1, 7).map(row => row.main_version));
  // The native source trigger atomically resets this persisted cursor when it
  // seals a newer value; replay must honor that frontier rather than a local one.
  f.state.after = f.selections[0]!.main_version;
  const offset = f.state.refreshed.length;
  expect(await refreshStandingRatingProjections(f.pool, { limit: 100 })).toMatchObject({ complete: true, publicationReady: true });
  expect(f.state.refreshed.slice(offset)).toEqual(f.selections.slice(1).map(row => row.main_version));
});

test('an identity fence commits independently of a borrowed transaction and outlives projection completion', async () => {
  const f = transport(3);
  const borrowed = { query() { throw new Error('must not borrow the journal transaction'); } } as unknown as PoolClient;
  await withAccessClient(f.pool, () => fenceStandingRatingTransition(f.pool, task), borrowed);
  expect(f.state.checkouts).toBe(1);
  expect(f.state.calls.at(-1)).toBe('COMMIT');
  expect(f.state.transition).toBe(true);
  expect(await refreshStandingRatingProjections(f.pool)).toMatchObject({ complete: true, publicationReady: false });
  expect(f.state.transition).toBe(true);
});

test('publication fencing reserves existing capacity, keeps the real nesting guard and closes with Access', async () => {
  const drivers = new Map<Pool, ReturnType<typeof transport>>();
  const connect = spyOn(Pool.prototype, 'connect').mockImplementation((async function (this: Pool) {
    let driver = drivers.get(this);
    if (!driver) { driver = transport(0); drivers.set(this, driver); }
    return driver.pool.connect();
  }) as Pool['connect']);
  const previous = nestedPoolCheckoutMode();
  setNestedPoolCheckoutMode('throw');
  const password = () => Promise.resolve('fixture-password');
  const parent = boundedPool({ max: 4, min: 4, password });
  let held: PoolClient | undefined;
  try {
    const guarded = notificationReadPool(parent), lane = reservedTransactionPool(guarded);
    expect(reservedTransactionPool(parent)).toBe(lane);
    expect(parent.options.max + lane.options.max).toBe(4);
    expect(parent.options.min).toBe(3);
    expect(lane.options.password).toBe(password);
    expect(lane.options.connectionTimeoutMillis).toBe(parent.options.connectionTimeoutMillis);
    held = await parent.connect();
    await withAccessClient(guarded, async () => {
      await expect(parent.connect()).rejects.toBeInstanceOf(NestedPoolCheckoutError);
      await fenceStandingRatingTransition(lane, task);
    }, held);
    expect(drivers.get(lane)?.state).toMatchObject({ transition: true, checkouts: 1 });
    expect(drivers.get(parent)?.state.calls).toEqual([]);
    expect(drivers.get(lane)?.state.calls.at(-1)).toBe('COMMIT');
    held.release(); held = undefined;
    await parent.end();
    expect(parent.ended).toBe(true);
    expect(lane.ended).toBe(true);
  } finally {
    held?.release();
    if (!parent.ended) await parent.end();
    setNestedPoolCheckoutMode(previous);
    connect.mockRestore();
  }
});

test('an undersized or already saturated pool cannot silently increase the fence connection budget', async () => {
  const parent = boundedPool({ max: 1 });
  try {
    expect(() => reservedTransactionPool(parent)).toThrow('Reserve the independent transaction connection');
    expect(parent.options.max).toBe(1);
  } finally { await parent.end(); }
  const full = boundedPool({ max: 2 });
  Object.defineProperty(full, 'totalCount', { value: 2 });
  try {
    expect(() => reservedTransactionPool(full)).toThrow('Reserve the independent transaction connection');
    expect(full.options.max).toBe(2);
  } finally { await full.end(); }
});

test('finishing a page commits before inspecting publication, and an unsettled horizon keeps exact reads held', async () => {
  const f = transport(3);
  f.state.unsettled = true;
  expect(await refreshStandingRatingProjections(f.pool)).toMatchObject({ complete: true, publicationReady: false });
  const commit = f.state.calls.indexOf('COMMIT');
  expect(f.state.calls.findIndex(sql => sql.includes('FROM access.rating_standing_publication() p'))).toBeGreaterThan(commit);
  f.state.unsettled = false;
  expect(await refreshStandingRatingProjections(f.pool)).toMatchObject({ refreshed: 0, complete: true, publicationReady: true });
});

test('invalid, held and cancelled pages cannot advance publication or dispatch late refreshes', async () => {
  for (const limit of [0, 101, 1.5]) {
    const f = transport(10);
    await expect(refreshStandingRatingProjections(f.pool, { limit })).rejects.toThrow('invalid standing publication page');
    expect(f.state.checkouts).toBe(0);
  }
  const held = transport(10); held.state.open = false;
  await expect(refreshStandingRatingProjections(held.pool)).rejects.toThrow('Recovery fence changed');
  expect(held.state.refreshed).toEqual([]);
  const cancelled = transport(10); cancelled.state.cancellation.abort();
  await expect(refreshStandingRatingProjections(cancelled.pool, {}, cancelled.state.cancellation.signal)).rejects.toThrow();
  expect(cancelled.state.checkouts).toBe(0);
  const interrupted = transport(10); interrupted.state.abortAfter = 1;
  await expect(refreshStandingRatingProjections(interrupted.pool, {}, interrupted.state.cancellation.signal)).rejects.toThrow();
  expect(interrupted.state.calls.filter(sql => sql.startsWith('SELECT access.refresh_rating_standing_slot'))).toHaveLength(1);
  expect(interrupted.state.releases).toEqual([true]);
  expect(interrupted.state.after).toBe(interrupted.selections[0]!.main_version);
  expect(interrupted.state.job).toBe(true);
  expect(interrupted.state.refreshed).toEqual([]);
  expect(await refreshStandingRatingProjections(interrupted.pool)).toMatchObject({ complete: true, publicationReady: true });
});

test('all standing relations declare custody and reconstruction while unknown relations remain conservative and fail the catalog guard', () => {
  const sources = ['2045_standing_rating_components.sql', '2077_standing_rating_publication.sql']
    .map(name => readFileSync(new URL(`../migrations/access/${name}`, import.meta.url), 'utf8'));
  const names = sources.flatMap(sql => [...sql.matchAll(/CREATE TABLE (access\.rating_standing_\w+)/g)].map(match => match[1]!));
  expect(names).toHaveLength(5);
  const tables: OwnerTable[] = names.map(name => ({ name, schema: 'access', table: name.slice(7), key: [], keyTypes: [], columns: [] }));
  assertAccessRecoveryClassification({ tables, excluded: {}, digest: 'fixture' });
  for (const table of tables) {
    const rule = ACCESS_RECOVERY_CLASSIFICATION[table.name]!;
    expect(accessRecoveryRule(table).class).toBe('authority');
    expect(rule.writer).toBeTruthy(); expect(rule.writerKind).toBeTruthy();
    expect(rule.reason).toBeTruthy(); expect(rule.rebuild).toBeTruthy();
  }
  const unknown = { ...tables[0]!, name: 'access.unclassified_standing_fixture', table: 'unclassified_standing_fixture' };
  expect(accessRecoveryRule(unknown)).toEqual({ class: 'authority' });
  expect(() => assertAccessRecoveryClassification({ tables: [unknown], excluded: {}, digest: 'fixture' })).toThrow('unclassified');
});
