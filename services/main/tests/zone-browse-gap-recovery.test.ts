import { expect, spyOn, test } from 'bun:test';
import type { Pool } from 'pg';
import { fusekiReadBudget } from '../src/infrastructure/fuseki.ts';
import { MAIN_RELAY_STREAM_SCOPE, type RelayHandoffPosition } from '../src/modules/outbox/relay-position.ts';
import type { CustodiedOutbox } from '../src/modules/outbox/relay.ts';
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

function slimCustody(): CustodiedOutbox {
  const receipt = 'urn:rezics:receipt:metadata';
  const batchId = 'urn:rezics:outbox:metadata';
  const eventId = 'urn:rezics:event:metadata';
  return {
    batch: { streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch: 'epoch', sequence: '4',
      routingEpoch: 'routing', graphSequence: '99', batchId, eventIds: [eventId], custodiedReceipt: receipt },
    events: [{ specversion: '1.0', id: eventId, source: 'https://rezics.com/services/main',
      type: 'com.rezics.work.metadata-changed.v1', datacontenttype: 'application/json',
      data: { batchId, routingEpoch: 'routing', ordinal: 0,
        sourcePosition: { datasetId: 'product', dataEpoch: 'epoch', sequence: '99' },
        relayPosition: { streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch: 'epoch', sequence: '4' },
        receipt: { id: receipt, action: 'work.edit', outcome: 'succeeded', admissionId: 'admission',
          requestDigest: 'a'.repeat(64), authorityEpoch: 'authority', scope: 'work', work: id(1) } } }],
  };
}

/** Owner doubles retain graph, delivered headers and SQL transactions independently.
 * Tests drive the real projection; a missing delivery never alters graph contents. */
function fixture(count = 65) {
  const graph = { rows: adoptions(count), sequence: '100', relaySequence: '5', available: true,
    malformed: false, failPage: false };
  const headers = new Set(['1', '2', '3', '4', '5']);
  const actualCounts = new Map<string, number>();
  const headerCounts = new Map<string, number>();
  const delivered = { sequence: '5', epoch: 'epoch' };
  const acknowledged = { sequence: '5', epoch: 'epoch' };
  const custody = { value: null as CustodiedOutbox | null, reads: [] as { epoch: string; sequence: string }[] };
  let candidates = new Map<string, Candidate>();
  let transaction: Map<string, Candidate> | undefined;
  const calls = { project: [] as number[], prune: [] as number[], rollback: 0, budgets: [] as boolean[],
    insert: 0, sql: [] as string[], graph: [] as string[], relay: [] as string[] };
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
    calls.relay.push(statement);
    if (/^(?:BEGIN|COMMIT|ROLLBACK|SET LOCAL)/.test(statement)) return { rows: [] };
    if (statement.includes('minimum_sequence')) {
      expect(values).toEqual([MAIN_RELAY_STREAM_SCOPE, 'epoch']);
      return { rows: [{ minimum_sequence: [...headers].sort((a, b) => Number(BigInt(a) - BigInt(b)))[0] ?? null,
        newest_delivered_sequence: delivered.sequence }] };
    }
    if (statement.includes('FROM relay.checkpoint')) {
      expect(values).toEqual(['test-relay']);
      expect(statement).not.toContain('data_epoch =');
      return { rows: [{ stream_scope: MAIN_RELAY_STREAM_SCOPE, data_epoch: acknowledged.epoch, sequence: acknowledged.sequence }] };
    }
    if (statement.includes('FROM relay.delivered_batch AS batch')) {
      const sequence = String(values[2]);
      expect(values.slice(0,2)).toEqual([MAIN_RELAY_STREAM_SCOPE, 'epoch']);
      return { rows: headers.has(sequence) ? [{ stream_scope: MAIN_RELAY_STREAM_SCOPE, data_epoch: 'epoch',
        sequence, batch_id: sequence === '4' ? 'urn:rezics:outbox:metadata' : `batch-${sequence}`,
        routing_epoch: 'routing', event_count: headerCounts.get(sequence) ?? 0,
        actual_count: String(actualCounts.get(sequence) ?? 0) }] : [] };
    }
    if (statement.includes('FROM relay.delivered_event')) return { rows: [] };
    throw new Error(`unexpected relay query: ${statement}`);
  };
  const relay = { query: relayQuery, connect: async () => ({ query: relayQuery, release() {} }) } as unknown as Pool;
  const fuseki = { query: async (query: string) => {
    calls.graph.push(query);
    calls.budgets.push(Boolean(fusekiReadBudget.getStore()));
    if (query.includes('SELECT ?controlSequence')) return { results: { bindings: [{
      controlSequence: { value: graph.relaySequence }, routing: { value: 'routing' },
    }] } };
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
  const env = { fuseki, lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } } as unknown as WorkActivationEnvironment;
  const instance = new ZoneBrowseProjection(access, relay, env, 'test-relay');
  const state = instance as unknown as { usableCut: boolean; checkpoint: RelayHandoffPosition };
  state.usableCut = true;
  state.checkpoint = { streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch: 'epoch', sequence: '3' };
  const current = () => instance.current({ dataEpoch: 'epoch', sequence: graph.sequence });
  const gap = async () => {
    actualCounts.set('4', 1);
    await expect(instance.tick()).rejects.toThrow('excess events');
    actualCounts.delete('4');
    expect(state.checkpoint.sequence).toBe('3');
    expect(await current()).toBe(false);
  };
  const finish = async () => {
    for (let page = 0; page < 32 && !state.usableCut; page++) {
      const before = calls.project.length;
      await instance.tick();
      expect(calls.project.length - before).toBeLessThanOrEqual(1);
      if (!state.usableCut) {
        expect(state.checkpoint.sequence).toBe('3');
        expect(await current()).toBe(false);
      }
    }
    expect(state.usableCut).toBe(true);
    expect(await current()).toBe(true);
  };
  return { instance, state, graph, headers, headerCounts, delivered, acknowledged, custody, calls, failures, gap, finish, current,
    supplyCustody: (value: CustodiedOutbox | null) => {
      custody.value = value;
      if (!headerCounts.has('4')) headers.delete('4');
      env.receiptCustody = { read: async (epoch: string, sequence: string) => {
        custody.reads.push({ epoch, sequence });
        return custody.value;
      } } as WorkActivationEnvironment['receiptCustody'];
    },
    candidates: () => candidates,
    seed: (row: Candidate) => { candidates.set(key(row), row); },
    afterPage: (run: () => void) => { afterPage = run; } };
}

test('explicit backfill waits for all pages and remains idempotent for preparation callers', async () => {
  const f = fixture(130);
  await f.instance.backfill();
  expect(f.state.usableCut).toBe(true);
  expect(await f.current()).toBe(true);
  expect(f.candidates().size).toBe(130);
  expect(f.state.checkpoint.sequence).toBe('5');
  await f.instance.backfill();
  expect(f.candidates().size).toBe(130);
  expect(await f.current()).toBe(true);
});

test('a repaired gap conflict recovers all authoritative candidates in bounded pages', async () => {
  const f = fixture(130);
  await f.gap();
  f.calls.budgets.length = 0;
  await f.instance.tick();
  expect(f.calls.project).toEqual([64]);
  expect(f.candidates().size).toBe(64);
  expect(f.state.checkpoint.sequence).toBe('3');
  expect(await f.current()).toBe(false);
  await f.finish();
  expect([...f.candidates().keys()].sort()).toEqual(f.graph.rows.map(key).sort());
  expect(f.state.checkpoint.sequence).toBe('5');
  expect(f.headers.has('4')).toBe(true);
  expect(f.calls.project.every(size => size <= 64)).toBe(true);
  expect(f.calls.prune.every(size => size <= 64)).toBe(true);
  expect(f.calls.budgets.every(Boolean)).toBe(true);
  expect(f.calls.sql.some(statement => /SET LOCAL.*lock_timeout/.test(statement))).toBe(true);
  expect(f.calls.sql.some(statement => /SET LOCAL.*statement_timeout/.test(statement))).toBe(true);
});

test('the gap-conflict worker fault records the requested sequence, checkpoint and relay epoch', async () => {
  const f = fixture(1);
  f.graph.relaySequence = '8';
  f.acknowledged.sequence = '5';
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
      'error.code': new WorkReadUnavailable('retained relay batch has excess events').code,
      'rezics.relay.requested_sequence': '4',
      'rezics.projection.checkpoint_sequence': '3',
      'rezics.relay.data_epoch': 'epoch',
      'rezics.relay.routing_epoch': 'routing',
      'rezics.relay.retention_floor': 'absent',
      'rezics.relay.minimum_retained_sequence': '1',
      'rezics.relay.newest_committed_sequence': '8',
      'rezics.relay.newest_delivered_sequence': '5',
      'rezics.relay.acknowledged_sequence': '5',
      'rezics.relay.custody_supplied': false,
      'rezics.relay.custody_found': false,
    });
  } finally { consoleError.mockRestore(); }
});

test('slim receipt custody supplies a missing batch without reconstructing SQL relay delivery', async () => {
  const f = fixture(1);
  f.supplyCustody(slimCustody());
  const lines: string[] = [];
  const consoleError = spyOn(console, 'error').mockImplementation((line: unknown) => { lines.push(String(line)); });
  try {
    expect(await f.instance.tick()).toBe(1);
    expect(f.state.checkpoint.sequence).toBe('4');
    expect(f.state.usableCut).toBe(true);
    expect(f.calls.project).toEqual([]);
    expect(lines).toEqual([]);
    expect(f.custody.reads.length).toBeGreaterThanOrEqual(2);
    expect(f.custody.reads.every(position => position.epoch === 'epoch' && position.sequence === '4')).toBe(true);
    expect(f.calls.relay.some(statement => /^\s*(INSERT|UPDATE|DELETE)\b/.test(statement))).toBe(false);
    expect(await f.instance.tick()).toBe(0);
    expect(f.state.checkpoint.sequence).toBe('5');
    expect(await f.current()).toBe(true);
  } finally { consoleError.mockRestore(); }
});

test('slim custody also supplies an incomplete SQL delivery without acknowledging it', async () => {
  const f = fixture(1);
  f.headers.add('4');
  f.headerCounts.set('4', 1);
  f.supplyCustody(slimCustody());
  expect(await f.instance.tick()).toBe(1);
  expect(f.state.checkpoint.sequence).toBe('4');
  expect(f.calls.project).toEqual([]);
  expect(f.calls.relay.some(statement => /^\s*(INSERT|UPDATE|DELETE)\b/.test(statement))).toBe(false);
});

test('custody from a foreign stream, epoch, routing cut or mismatched envelope cannot advance', async () => {
  const corruptions: ((value: CustodiedOutbox) => void)[] = [
    value => { Object.assign(value.batch, { streamScope: 'urn:rezics:stream:foreign' }); },
    value => { value.batch.dataEpoch = 'foreign'; },
    value => { value.batch.routingEpoch = 'foreign'; },
    value => { value.events[0]!.data.receipt.id = 'urn:rezics:receipt:other'; },
    value => { value.events[0]!.data.relayPosition!.sequence = '5'; },
    value => { Object.assign(value.events[0]!, { source: 'https://rezics.com/services/foreign' }); },
  ];
  for (const corrupt of corruptions) {
    const f = fixture(1);
    const retained = slimCustody();
    corrupt(retained);
    f.supplyCustody(retained);
    await expect(f.instance.tick()).rejects.toThrow();
    expect(f.state.checkpoint.sequence).toBe('3');
    expect(f.calls.project).toEqual([]);
    expect(await f.current()).toBe(false);
  }
});

test('finding 1: absent custody and a healing missing header defer without a gap fault', async () => {
  const f = fixture(1);
  f.supplyCustody(null);
  const lines: string[] = [];
  const consoleError = spyOn(console, 'error').mockImplementation(line => { lines.push(String(line)); });
  try {
    expect(await f.instance.tick()).toBe(0);
    expect(f.custody.reads).toContainEqual({ epoch: 'epoch', sequence: '4' });
    expect(f.instance.recoveryStatus().state).toBe('incomplete-healing');
    expect(lines).toEqual([]);
    f.headers.add('4');
    expect(await f.instance.tick()).toBe(0);
    expect(f.state.checkpoint.sequence).toBe('4');
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

test('an incomplete restored batch preserves the usable cut, defers without faults and resumes from custody', async () => {
  const f = fixture(1);
  f.headers.add('4');
  f.headerCounts.set('4', 1);
  f.seed({ ...f.graph.rows[0]!, adopted_order: '7' });
  const lines: string[] = [];
  const consoleError = spyOn(console, 'error').mockImplementation(line => { lines.push(String(line)); });
  try {
    for (let poll = 0; poll < 4; poll++) {
      expect(await f.instance.tick()).toBe(0);
      expect(f.state.checkpoint.sequence).toBe('3');
      expect(f.state.usableCut).toBe(true);
      expect(await f.current()).toBe(false);
      expect(f.candidates().size).toBe(1);
    }
    expect(lines).toEqual([]);
    f.supplyCustody(slimCustody());
    expect(await f.instance.tick()).toBe(1);
    expect(f.state.checkpoint.sequence).toBe('4');
    expect(await f.instance.tick()).toBe(0);
    expect(f.state.checkpoint.sequence).toBe('5');
    expect(await f.current()).toBe(true);
  } finally { consoleError.mockRestore(); }
});

test('a restored Zone cursor ahead of acknowledgement preserves its cut and resumes without faults', async () => {
  const f = fixture(1);
  f.seed({ ...f.graph.rows[0]!, adopted_order: '7' });
  f.acknowledged.sequence = '2';
  const faults: string[] = [], deferred: string[] = [];
  const error = spyOn(console, 'error').mockImplementation(line => { faults.push(String(line)); });
  const warn = spyOn(console, 'warn').mockImplementation(line => { deferred.push(String(line)); });
  try {
    for (let poll = 0; poll < 4; poll++) {
      expect(await f.instance.tick()).toBe(0);
      expect(f.state.checkpoint.sequence).toBe('3');
      expect(f.state.usableCut).toBe(true);
      expect(await f.current()).toBe(false);
      expect(f.candidates().size).toBe(1);
    }
    expect(faults).toEqual([]);
    expect(deferred.map(line => JSON.parse(line))).toEqual(Array.from({ length: 4 }, () => expect.objectContaining({
      event: 'worker_run_deferred', 'error.code': 'main_relay_handoff_incomplete',
      'rezics.relay.requested_sequence': '3',
      'rezics.projection.recovery_retry_ms': ZONE_BROWSE_PROJECTION_COST.pollMs,
    })));
    f.acknowledged.sequence = '3';
    expect(await f.instance.tick()).toBe(0);
    expect(await f.current()).toBe(false);
    expect(f.state.checkpoint.sequence).toBe('3');
  } finally { error.mockRestore(); warn.mockRestore(); }
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
  f.acknowledged.sequence = '6';
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
  f.acknowledged.sequence = '6';
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
  f.acknowledged.epoch = 'restored';
  await expect(f.instance.tick()).rejects.toBeInstanceOf(WorkReadUnavailable);
  expect(f.state.checkpoint.sequence).toBe('3');
  f.delivered.epoch = 'epoch';
  f.acknowledged.epoch = 'epoch';
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
    expect(f.state.usableCut).toBe(false);
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

test('sustained unrelated writes defer reconciliation after three attempts and resume after bounded cooldown', async () => {
  const f = fixture();
  await f.gap();
  let now = 0;
  const clock = spyOn(performance, 'now').mockImplementation(() => now);
  const lines: string[] = [];
  const consoleWarn = spyOn(console, 'warn').mockImplementation((line: unknown) => { lines.push(String(line)); });
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      f.afterPage(() => { f.graph.sequence = String(BigInt(f.graph.sequence) + 1n); });
      await expect(f.instance.tick()).rejects.toBeInstanceOf(WorkReadUnavailable);
      expect(f.instance.recoveryStatus().attempts).toBe(attempt);
      expect(f.state.checkpoint.sequence).toBe('3');
      expect(await f.current()).toBe(false);
    }
    expect(f.instance.recoveryStatus()).toEqual({ state: 'waiting-for-cut', attempts: 3, retryAfterMs: 30_000,
      checkpoint: { streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch: 'epoch', sequence: '3' } });
    const deferred = lines.map(line => JSON.parse(line) as Record<string, unknown>)
      .find(line => line.event === 'worker_run_deferred');
    expect(deferred).toMatchObject({ event: 'worker_run_deferred',
      'rezics.projection.recovery_state': 'waiting-for-cut', 'rezics.projection.recovery_attempts': 3,
      'rezics.projection.recovery_retry_ms': 30_000, 'rezics.projection.checkpoint_sequence': '3' });
    const queries = { graph: f.calls.graph.length, relay: f.calls.relay.length, sql: f.calls.sql.length };
    for (let poll = 0; poll < 3; poll++) expect(await f.instance.tick()).toBe(0);
    expect(await f.current()).toBe(false);
    await expect(f.instance.batch(realm, 'newest', null)).rejects.toBeInstanceOf(WorkReadUnavailable);

    let poll: (() => void) | undefined;
    const interval = spyOn(globalThis, 'setInterval').mockImplementation(((callback: TimerHandler) => {
      poll = callback as () => void;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval);
    const clear = spyOn(globalThis, 'clearInterval').mockImplementation(() => {});
    try {
      f.instance.start();
      expect(poll).toBeDefined();
      poll!();
      await f.instance.stop();
    } finally {
      interval.mockRestore();
      clear.mockRestore();
    }
    expect({ graph: f.calls.graph.length, relay: f.calls.relay.length, sql: f.calls.sql.length }).toEqual(queries);
    now = 30_001;
    await f.finish();
    expect(f.instance.recoveryStatus()).toMatchObject({ state: 'ready', attempts: 0, retryAfterMs: 0 });
    expect(f.candidates().size).toBe(65);
    expect(f.state.checkpoint.sequence).toBe('5');
  } finally {
    clock.mockRestore();
    consoleWarn.mockRestore();
  }
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
