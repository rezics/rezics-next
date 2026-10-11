import { expect, spyOn, test } from 'bun:test';
import type { Pool } from 'pg';
import { fusekiReadBudget } from '../src/infrastructure/fuseki.ts';
import { MAIN_RELAY_STREAM_SCOPE, type RelayHandoffPosition } from '../src/modules/outbox/relay-position.ts';
import { ZoneBrowseProjection, ZONE_BROWSE_PROJECTION_COST } from '../src/modules/zone-browse/store.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { WorkReadUnavailable } from '../src/modules/work/read-session.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const realm = id(999);
type Adoption = { realm: string; work: string; sequence: string; epochOrder: string };
type Candidate = { realm: string; work: string; adopted_order: string };
const key = (row: { realm: string; work: string }) => `${row.realm}\n${row.work}`;
const order = (a: { realm: string; work: string }, b: { realm: string; work: string }) => key(a).localeCompare(key(b));
const adoptions = (count: number): Adoption[] => Array.from({ length: count }, (_, index) => ({
  realm, work: id(index + 1), sequence: String(index + 1), epochOrder: '1',
}));

/** Owner doubles retain graph, delivered headers and SQL transactions independently.
 * Tests drive the real projection; a missing delivery never alters graph contents. */
function fixture(count = 65) {
  const graph = { rows: adoptions(count), sequence: '100', relaySequence: '5', available: true,
    malformed: false, failPage: false };
  const headers = new Set(['5']);
  const headerCounts = new Map<string, number>();
  const delivered = { sequence: '5', epoch: 'epoch' };
  let candidates = new Map<string, Candidate>();
  let transaction: Map<string, Candidate> | undefined;
  const calls = { project: [] as number[], prune: [] as number[], rollback: 0, budgets: [] as boolean[],
    insert: 0, sql: [] as string[] };
  const failures = { insertAt: 0 };
  let afterPage: (() => void) | undefined;
  const sql = async (statement: string, values: unknown[] = []) => {
    calls.sql.push(statement);
    if (statement === 'BEGIN') { transaction = new Map(candidates); return { rows: [] }; }
    if (statement === 'COMMIT') { if (transaction) candidates = transaction; transaction = undefined; return { rows: [] }; }
    if (statement === 'ROLLBACK') { calls.rollback++; transaction = undefined; return { rows: [] }; }
    if (/SET LOCAL|set_config|serial_stats_checkpoint/.test(statement) && !statement.includes('zone_browse_entry')) {
      return { rows: [] };
    }
    if (statement.includes('INSERT INTO access.zone_browse_entry')) {
      calls.insert++;
      if (failures.insertAt === calls.insert) throw new Error('candidate write failed');
      const candidate = { realm: String(values[0]), work: String(values[1]), adopted_order: String(values[2]) };
      const target = transaction ?? candidates;
      const prior = target.get(key(candidate));
      target.set(key(candidate), prior ?? candidate);
      return { rows: [] };
    }
    if (statement.includes('DELETE FROM access.zone_browse_entry')) {
      (transaction ?? candidates).delete(key({ realm: String(values[0]), work: String(values[1]) }));
      return { rows: [] };
    }
    if (statement.includes('FROM access.zone_browse_entry') && /SELECT\s+(?:entry\.)?realm/.test(statement)) {
      const rows = [...candidates.values()].sort(order).filter(row => !values[0]
        || order(row, { realm: String(values[0]), work: String(values[1]) }) > 0)
        .slice(0, ZONE_BROWSE_PROJECTION_COST.batch);
      calls.prune.push(rows.length);
      return { rows };
    }
    throw new Error(`unexpected candidate query: ${statement}`);
  };
  const access = { query: sql, connect: async () => ({ query: sql, release() {} }) } as unknown as Pool;
  const relayQuery = async (statement: string, values: unknown[] = []) => {
    if (/^(?:BEGIN|COMMIT|ROLLBACK|SET LOCAL)/.test(statement)) return { rows: [] };
    if (statement.includes('coalesce(max(sequence),0)::text AS sequence')) {
      return { rows: [{ stream_scope: MAIN_RELAY_STREAM_SCOPE, data_epoch: delivered.epoch, sequence: delivered.sequence }] };
    }
    if (statement.includes('FROM relay.delivered_batch AS batch')) {
      const next = [...headers].filter(sequence => BigInt(sequence) > BigInt(String(values[2])))
        .sort((a, b) => Number(BigInt(a) - BigInt(b)))[0];
      return { rows: next ? [{ stream_scope: MAIN_RELAY_STREAM_SCOPE, data_epoch: 'epoch', sequence: next,
        event_count: headerCounts.get(next) ?? 0 }] : [] };
    }
    if (statement.includes('count(*)::text AS actual_count')) return { rows: [{ actual_count: '0' }] };
    if (statement.includes('FROM relay.delivered_event')) return { rows: [] };
    throw new Error(`unexpected relay query: ${statement}`);
  };
  const relay = { query: relayQuery, connect: async () => ({ query: relayQuery, release() {} }) } as unknown as Pool;
  const fuseki = { query: async (query: string) => {
    calls.budgets.push(Boolean(fusekiReadBudget.getStore()));
    if (query.includes('SELECT ?epoch ?prior')) return { results: { bindings: [] } };
    if (query.includes('SELECT ?sequence')) {
      expect(query).toContain('?relaySequence');
      expect(query).toContain(MAIN_RELAY_STREAM_SCOPE);
      return { results: { bindings: graph.available ? [{ sequence: { value: graph.sequence },
        relaySequence: { value: graph.relaySequence } }] : [] } };
    }
    if (query.includes('SELECT DISTINCT ?realm ?work')) {
      if (graph.failPage) throw new Error('graph page failed');
      const selected = /VALUES \(\?realm \?work\) \{([^}]+)\}/.exec(query)?.[1];
      const pairs = selected ? [...selected.matchAll(/\(<([^>]+)> <([^>]+)>\)/g)]
        .map(match => ({ realm: match[1]!, work: match[2]! })) : undefined;
      const afterRealm = /STR\(\?realm\) > "([^"]+)"/.exec(query)?.[1];
      const afterWork = /STR\(\?work\) > "([^"]+)"/.exec(query)?.[1];
      const rows = graph.rows.filter(row => (!pairs || pairs.some(pair => key(pair) === key(row)))
        && (!afterRealm || order(row, { realm: afterRealm, work: afterWork! }) > 0))
        .sort(order).slice(0, ZONE_BROWSE_PROJECTION_COST.batch);
      calls.project.push(rows.length);
      const bindings = rows.map(row => Object.fromEntries(Object.entries(row)
        .map(([name, value]) => [name, { value: graph.malformed && name === 'sequence' ? 'bad' : value }])));
      afterPage?.();
      afterPage = undefined;
      return { results: { bindings } };
    }
    throw new Error(`unexpected graph query: ${query}`);
  } };
  const instance = new ZoneBrowseProjection(access, relay, { fuseki,
    lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } } as unknown as WorkActivationEnvironment);
  const state = instance as unknown as { ready: boolean; checkpoint: RelayHandoffPosition };
  state.ready = true;
  state.checkpoint = { streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch: 'epoch', sequence: '3' };
  const current = () => instance.current({ dataEpoch: 'epoch', sequence: graph.sequence });
  const gap = async () => {
    await expect(instance.tick()).rejects.toThrow('missing batch');
    expect(state.checkpoint.sequence).toBe('3');
    expect(await current()).toBe(false);
  };
  const finish = async () => {
    for (let page = 0; page < 32 && !state.ready; page++) {
      const before = calls.project.length;
      await instance.tick();
      expect(calls.project.length - before).toBeLessThanOrEqual(1);
      if (!state.ready) {
        expect(state.checkpoint.sequence).toBe('3');
        expect(await current()).toBe(false);
      }
    }
    expect(state.ready).toBe(true);
    expect(await current()).toBe(true);
  };
  return { instance, state, graph, headers, headerCounts, delivered, calls, failures, gap, finish, current,
    candidates: () => candidates,
    seed: (row: Candidate) => { candidates.set(key(row), row); },
    afterPage: (run: () => void) => { afterPage = run; } };
}

test('a missing header that never arrives recovers all authoritative candidates in bounded pages', async () => {
  const f = fixture(130);
  await f.gap();
  await f.instance.tick();
  expect(f.calls.project).toEqual([64]);
  expect(f.candidates().size).toBe(64);
  expect(f.state.checkpoint.sequence).toBe('3');
  expect(await f.current()).toBe(false);
  await f.finish();
  expect([...f.candidates().keys()].sort()).toEqual(f.graph.rows.map(key).sort());
  expect(f.state.checkpoint.sequence).toBe('5');
  expect(f.headers.has('4')).toBe(false);
  expect(f.calls.project.every(size => size <= 64)).toBe(true);
  expect(f.calls.prune.every(size => size <= 64)).toBe(true);
  expect(f.calls.budgets.every(Boolean)).toBe(true);
  expect(f.calls.sql.some(statement => /SET LOCAL.*lock_timeout/.test(statement))).toBe(true);
  expect(f.calls.sql.some(statement => /SET LOCAL.*statement_timeout/.test(statement))).toBe(true);
});

test('the missing-batch worker fault records the requested sequence, checkpoint and relay epoch', async () => {
  const f = fixture(1);
  const lines: string[] = [];
  const consoleError = spyOn(console, 'error').mockImplementation((line: unknown) => { lines.push(String(line)); });
  try {
    await f.gap();
    const fault = lines.map(line => JSON.parse(line) as Record<string, unknown>)
      .find(line => line.event === 'worker_fault');
    expect(fault).toMatchObject({
      event: 'worker_fault', level: 'error',
      'rezics.worker.name': 'main.zone-browse.projection',
      'error.class': 'WorkReadUnavailable',
      'error.code': new WorkReadUnavailable('Zone browse Main relay has a missing batch').code,
      'rezics.relay.requested_sequence': '4',
      'rezics.projection.checkpoint_sequence': '3',
      'rezics.relay.data_epoch': 'epoch',
    });
  } finally { consoleError.mockRestore(); }
});

test('a late missing batch below the captured coverage does not interrupt graph reconciliation', async () => {
  const f = fixture();
  await f.gap();
  await f.instance.tick();
  f.headers.add('4');
  await f.finish();
  expect(f.candidates().has(key(f.graph.rows[64]!))).toBe(true);
  expect(f.candidates().size).toBe(65);
  expect(f.state.checkpoint.sequence).toBe('5');
  expect(await f.instance.tick()).toBe(0);
});

test('an incomplete retained batch rebuilds from graph instead of waiting for missing events', async () => {
  const f = fixture(1);
  f.headers.add('4');
  f.headerCounts.set('4', 1);
  await expect(f.instance.tick()).rejects.toThrow('incomplete');
  expect(f.state.checkpoint.sequence).toBe('3');
  expect(await f.current()).toBe(false);
  await f.finish();
  expect(f.candidates().size).toBe(1);
  expect(f.state.checkpoint.sequence).toBe('5');
});

test('a later graph mutation and delivery invalidate the cut before checkpoint advancement', async () => {
  const f = fixture();
  await f.gap();
  await f.instance.tick();
  const added = { realm, work: id(100), sequence: '101', epochOrder: '1' };
  f.graph.rows.push(added);
  f.graph.sequence = '101';
  f.graph.relaySequence = '6';
  f.delivered.sequence = '6';
  f.headers.add('6');
  await expect(f.instance.tick()).rejects.toBeInstanceOf(WorkReadUnavailable);
  expect(f.state.checkpoint.sequence).toBe('3');
  expect(await f.current()).toBe(false);
  await f.finish();
  expect(f.candidates().has(key(added))).toBe(true);
  expect(f.state.checkpoint.sequence).toBe('6');
});

test('new delivery coverage at an unchanged authoritative cut requires another full reconciliation', async () => {
  const f = fixture(1);
  f.graph.relaySequence = '6';
  await f.gap();
  await f.instance.tick();
  f.delivered.sequence = '6';
  f.headers.add('6');
  await expect(f.instance.tick()).rejects.toThrow('coverage changed');
  expect(f.state.checkpoint.sequence).toBe('3');
  expect(await f.current()).toBe(false);
  const projected = f.calls.project.length;
  await f.finish();
  expect(f.calls.project.length).toBeGreaterThan(projected);
  expect(f.state.checkpoint.sequence).toBe('6');
});

test('reconciliation prunes obsolete candidates and preserves immutable adoption order', async () => {
  const f = fixture(2);
  const kept = f.graph.rows[0]!;
  f.seed({ ...kept, adopted_order: '7' });
  const obsolete = { realm, work: id(900), adopted_order: '8' };
  f.seed(obsolete);
  await f.gap();
  await f.finish();
  expect(f.candidates().size).toBe(2);
  expect(f.candidates().has(key(obsolete))).toBe(false);
  expect(f.candidates().get(key(kept))?.adopted_order).toBe('7');
});

test('more than one page of obsolete candidates is pruned with bounded continuation', async () => {
  const f = fixture(1);
  const kept = f.graph.rows[0]!;
  f.seed({ ...kept, adopted_order: '7' });
  for (let stale = 0; stale < 130; stale++) f.seed({ realm, work: id(600 + stale), adopted_order: '8' });
  await f.gap();
  await f.finish();
  expect(f.calls.prune).toEqual([64, 64, 3]);
  expect([...f.candidates().keys()]).toEqual([key(kept)]);
  expect(f.candidates().get(key(kept))?.adopted_order).toBe('7');
});

test('a hold or unavailable graph cut retains the prior checkpoint until recovery can restart', async () => {
  const f = fixture(1);
  await f.gap();
  f.graph.available = false;
  await expect(f.instance.tick()).rejects.toBeInstanceOf(WorkReadUnavailable);
  expect(f.state.checkpoint.sequence).toBe('3');
  expect(f.candidates().size).toBe(0);
  f.graph.available = true;
  await f.finish();
});

test('a foreign relay epoch and graph page failure cannot make recovery current', async () => {
  const f = fixture(1);
  await f.gap();
  f.delivered.epoch = 'restored';
  await expect(f.instance.tick()).rejects.toBeInstanceOf(WorkReadUnavailable);
  expect(f.state.checkpoint.sequence).toBe('3');
  f.delivered.epoch = 'epoch';
  f.graph.failPage = true;
  await expect(f.instance.tick()).rejects.toThrow('graph page failed');
  expect(f.state.checkpoint.sequence).toBe('3');
  expect(await f.current()).toBe(false);
  f.graph.failPage = false;
  await f.finish();
});

test('a source head behind delivered coverage cannot validate a graph rebuild', async () => {
  const f = fixture(1);
  await f.gap();
  f.graph.relaySequence = '4';
  let unavailable: unknown;
  for (let page = 0; page < 8 && !unavailable; page++) {
    try { await f.instance.tick(); } catch (error) { unavailable = error; }
    expect(f.state.ready).toBe(false);
  }
  expect(unavailable).toBeInstanceOf(WorkReadUnavailable);
  expect(f.state.checkpoint.sequence).toBe('3');
  expect(await f.current()).toBe(false);
  f.graph.relaySequence = '5';
  await f.finish();
});

test('a graph change during a page invalidates recovery and retries from a new authoritative cut', async () => {
  const f = fixture(1);
  await f.gap();
  f.afterPage(() => { f.graph.sequence = '101'; });
  await expect(f.instance.tick()).rejects.toBeInstanceOf(WorkReadUnavailable);
  expect(f.state.checkpoint.sequence).toBe('3');
  expect(await f.current()).toBe(false);
  await f.finish();
});

test('partial SQL failures roll back the page and retry without losing candidates', async () => {
  const f = fixture(3);
  await f.gap();
  f.failures.insertAt = 2;
  await expect(f.instance.tick()).rejects.toThrow('candidate write failed');
  expect(f.calls.rollback).toBe(1);
  expect(f.candidates().size).toBe(0);
  expect(f.state.checkpoint.sequence).toBe('3');
  expect(await f.current()).toBe(false);
  f.failures.insertAt = 0;
  await f.finish();
  expect(f.candidates().size).toBe(3);
});

test('malformed authoritative rows fail recovery rather than silently advancing past them', async () => {
  const f = fixture(1);
  await f.gap();
  f.graph.malformed = true;
  await expect(f.instance.tick()).rejects.toBeInstanceOf(WorkReadUnavailable);
  expect(f.state.checkpoint.sequence).toBe('3');
  expect(await f.current()).toBe(false);
  f.graph.malformed = false;
  await f.finish();
});

test('a reconciliation page stops at its time budget and can retry without advancing', async () => {
  const f = fixture(1);
  await f.gap();
  let elapsed = 0;
  const clock = spyOn(performance, 'now').mockImplementation(() => elapsed);
  try {
    f.afterPage(() => { elapsed = ZONE_BROWSE_PROJECTION_COST.recoveryPageMs + 1; });
    await expect(f.instance.tick()).rejects.toThrow('time budget');
    expect(f.state.checkpoint.sequence).toBe('3');
    expect(f.candidates().size).toBe(0);
    expect(await f.current()).toBe(false);
  } finally { clock.mockRestore(); }
  await f.finish();
  expect(f.candidates().size).toBe(1);
});
