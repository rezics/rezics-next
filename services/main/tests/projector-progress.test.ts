import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { AlsoEnjoyedStore } from '../src/modules/also-enjoyed/store.ts';
import { automaticCoReaders } from '../src/modules/also-enjoyed/automation.ts';
import { RecommendationRestart } from '../src/modules/recommendation/derived-generation.ts';
import { DiscoveryRefreshWorker } from '../src/modules/discovery/refresh.ts';
import { DISCOVERY_REFRESH_COST } from '../src/modules/discovery/refresh-store.ts';
import type { DiscoveryProjection } from '../src/modules/discovery/store.ts';
import { RealmDirectoryIndex } from '../src/modules/realm-directory/index.ts';
import { RealmDirectoryWorker } from '../src/modules/realm-directory/worker.ts';
import { WorkReadMoved } from '../src/modules/work/read-session.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

/** One publish of the pin already read, the mirror steps, and the pass that
 * reaches a head that then stays still. Seven ticks cover that schedule. */
const REALM_DIRECTORY_BOUND = 7;
/** One short page per phase: ratings, shelves, pairs. */
const CO_READER_BOUND = 3;
const CATALOG_RESOURCES = DISCOVERY_REFRESH_COST.catalogSize + 5;
/** Two keyset pages cover the catalog. */
const CATALOG_BOUND = 2;

const realm = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

interface MovingSource {
  /** Sequence the next position read returns. Advances after every read until frozen. */
  head: bigint;
  frozen: boolean;
  epoch: string;
  hold: boolean;
  reads: number;
}

function movingSource(sequence = 5n): MovingSource {
  return { head: sequence, frozen: false, epoch: 'epoch', hold: false, reads: 0 };
}

function positionAnswer(source: MovingSource, changeEpochOnSecondRead = false) {
  source.reads += 1;
  if (source.hold) return { results: { bindings: [] } };
  const sequence = source.head;
  const epoch = changeEpochOnSecondRead && source.reads === 2 ? 'restored' : source.epoch;
  if (!source.frozen) source.head += 1n;
  return { results: { bindings: [{ epoch: { value: epoch }, sequence: { value: sequence.toString() } }] } };
}

function workDeps(source: MovingSource, query: (sparql: string) => { results: { bindings: object[] } },
  extra: Partial<MainWorkDependencies> = {}): MainWorkDependencies {
  return {
    environment: {
      lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' },
      fuseki: { query: async (sparql: string) => sparql.includes('routingEpoch')
        ? positionAnswer(source) : query(sparql) },
    },
    access: { assertRecoveryOpen: async () => {} },
    ...extra,
  } as unknown as MainWorkDependencies;
}

interface DirectoryRow {
  data_epoch: string; sequence: string; generation: number; revision: string;
  build_data_epoch: string; build_base_sequence: string; target_sequence: string | null;
  spare_sequence: string | null; refresh_after: string; rebuilding: boolean;
  phase: string;
}

function directoryHarness(options: { holdOnFence?: boolean; builderConflict?: boolean } = {}) {
  const source = movingSource(5n);
  const fences: string[] = [];
  const row: DirectoryRow = {
    data_epoch: 'epoch', sequence: '1', generation: 0, revision: '1',
    build_data_epoch: 'epoch', build_base_sequence: '1', target_sequence: '5',
    spare_sequence: null, refresh_after: '', rebuilding: true, phase: 'graph',
  };
  let snapshot: DirectoryRow | null = null;
  const saved = () => snapshot ?? row;
  const query = async (sql: string, params: unknown[] = []) => {
    if (sql === 'BEGIN') { snapshot = { ...row }; return { rows: [], rowCount: 0 }; }
    if (sql === 'COMMIT') {
      if (snapshot) Object.assign(row, snapshot);
      snapshot = null;
      return { rows: [], rowCount: 0 };
    }
    if (sql === 'ROLLBACK') { snapshot = null; return { rows: [], rowCount: 0 }; }
    if (sql.startsWith('SET LOCAL') || sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 0 };
    if (sql.includes('SELECT generation::text FROM access.recovery_fence')) return { rows: [{ generation: '4' }], rowCount: 1 };
    if (sql.includes('realm_directory_position') && sql.includes('revision = $1')) {
      const current = saved();
      const matches = !options.builderConflict && String(params[0]) === current.revision;
      return { rows: matches ? [{}] : [], rowCount: matches ? 1 : 0 };
    }
    if (sql.includes('FROM access.realm_directory_position')) return { rows: [{ ...saved() }], rowCount: 1 };
    if (sql.includes('FROM access.recovery_fence')) return { rows: [{}], rowCount: 1 };
    if (sql.startsWith('DELETE') || sql.startsWith('INSERT') || sql.includes('DELETE FROM access.realm_directory')) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('UPDATE access.realm_directory_position')) {
      const current = saved();
      const publish = params[0] === true;
      if (publish) {
        current.data_epoch = String(params[1]);
        current.sequence = String(params[2]);
        current.generation = Number(params[3]);
      }
      current.build_data_epoch = String(params[1]);
      current.build_base_sequence = String(params[4]);
      current.target_sequence = params[5] === null || params[5] === undefined ? null : String(params[5]);
      current.refresh_after = String(params[6]);
      current.rebuilding = params[7] === true;
      current.phase = String(params[8]);
      current.spare_sequence = params[9] === null || params[9] === undefined ? null : String(params[9]);
      current.revision = String(BigInt(current.revision) + 1n);
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected directory sql: ${sql.slice(0, 160)}`);
  };
  const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
  const index = new RealmDirectoryIndex(pool);
  const deps = workDeps(source, sparql => {
    if (sparql.includes('restoreHold')) {
      fences.push(source.head.toString());
      if (options.holdOnFence) return { results: { bindings: [] } };
      return { results: { bindings: [{ sequence: { value: source.head.toString() } }] } };
    }
    return { results: { bindings: [] } };
  }, { access: { assertRecoveryOpen: async () => {}, realmDirectory: index } as never });
  return { source, row, fences, worker: new RealmDirectoryWorker(deps) };
}

test('realm directory commits the cut it read while the graph moves and later ticks reach the head', async () => {
  const run = directoryHarness();
  expect(await run.worker.tick()).toBe(false);
  expect(run.row.sequence).toBe('5');
  expect(run.fences.length).toBeGreaterThan(0);
  expect(BigInt(run.fences[0]!)).toBeGreaterThan(5n);
  const seen = [run.row.sequence];
  let calls = 1;
  while (seen.length < 2 && calls < REALM_DIRECTORY_BOUND) {
    const prior = run.row.sequence;
    await run.worker.tick();
    calls += 1;
    expect(BigInt(run.row.sequence) >= BigInt(prior)).toBe(true);
    if (run.row.sequence !== prior) seen.push(run.row.sequence);
  }
  expect(seen.length).toBeGreaterThanOrEqual(2);
  expect(calls).toBeLessThanOrEqual(REALM_DIRECTORY_BOUND);
  run.source.frozen = true;
  const head = run.source.head.toString();
  let caughtUp = false;
  while (calls < REALM_DIRECTORY_BOUND) {
    calls += 1;
    const prior = run.row.sequence;
    await run.worker.tick();
    expect(BigInt(run.row.sequence) >= BigInt(prior)).toBe(true);
    if (run.row.sequence === head && run.row.phase === 'idle') { caughtUp = true; break; }
  }
  expect(caughtUp).toBe(true);
  expect(calls).toBe(REALM_DIRECTORY_BOUND);
  expect(await run.worker.tick()).toBe(true);
  expect(run.row.sequence).toBe(head);
});

test('realm directory still refuses a restore hold or a lost builder and does not publish', async () => {
  const held = directoryHarness({ holdOnFence: true });
  await expect(held.worker.tick()).rejects.toThrow('Realm directory source is held');
  expect(held.row.sequence).toBe('1');
  expect(held.row.phase).toBe('graph');
  const conflict = directoryHarness({ builderConflict: true });
  await expect(conflict.worker.tick()).rejects.toThrow('Realm directory builder changed');
  expect(conflict.row.sequence).toBe('1');
});

test('realm directory reads still refuse when the published cut changes', async () => {
  let sequence = '8';
  const query = async (sql: string) => {
    if (sql.includes('realm_count_basis')) return { rows: [{ revision: '4' }], rowCount: 1 };
    if (sql.includes('realm_directory_position')) return { rows: [{ data_epoch: 'epoch', sequence }], rowCount: 1 };
    throw new Error(sql.slice(0, 120));
  };
  const index = new RealmDirectoryIndex({ query } as unknown as Pool);
  await index.fence('4', false, { dataEpoch: 'epoch', sequence: '8' });
  sequence = '9';
  await expect(index.fence('4', false, { dataEpoch: 'epoch', sequence: '8' }))
    .rejects.toThrow('Realm directory source changed');
});

interface CoReaderRow { phase: string; after_key: string; graph_sequence: string }

function coReaderHarness() {
  const source = movingSource(10n);
  const generation: CoReaderRow = { phase: 'ratings', after_key: '', graph_sequence: '4' };
  const observation = 'https://rezics.com/id/00000000-0000-4000-8000-0000000000aa';
  const rating = { context: 'ctx', main_version: 'main', slot: 'slot', observation,
    revision: realm(1), work: realm(2), agent: realm(3) };
  const clientQuery = async (sql: string) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.startsWith('SET LOCAL')) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('recovery_fence')) return { rows: [{ open: true }], rowCount: 1 };
    if (sql.includes('lease_epoch = lease_epoch + 1')) return { rows: [{ lease_epoch: '1' }], rowCount: 1 };
    if (sql.includes('lease_epoch = $2')) return { rows: [], rowCount: 1 };
    if (sql.includes('FROM access.also_enjoyed_generation a')) {
      return { rows: [{ ...generation, graph_epoch: 'epoch', state: 'building', generation_id: 'gen',
        access_revision: '1', content_revision: '1', signal_count: '0', pair_count: '0' }], rowCount: 1 };
    }
    if (sql.includes('WITH page AS MATERIALIZED')) {
      return { rows: generation.phase === 'ratings' ? [rating] : [], rowCount: generation.phase === 'ratings' ? 1 : 0 };
    }
    if (sql.includes('SELECT DISTINCT work FROM access.also_enjoyed_signal')) return { rows: [], rowCount: 0 };
    if (sql.includes('SELECT phase, signal_count')) {
      return { rows: [{ phase: generation.phase, signal_count: '0', pair_count: '0' }], rowCount: 1 };
    }
    if (sql.includes('signal_count::text')) {
      return { rows: [{ signal_count: '1', pair_count: '0' }], rowCount: 1 };
    }
    if (sql.startsWith('INSERT') || sql.startsWith('UPDATE')) return { rows: [], rowCount: 1 };
    throw new Error(`unexpected co-reader sql: ${sql.slice(0, 180)}`);
  };
  // The phase update passes the next phase as a bind parameter, not inline SQL.
  const query = async (sql: string, params: unknown[] = []) => {
    if (sql.includes('UPDATE access.also_enjoyed_generation SET phase')) {
      generation.phase = String(params[1]);
      generation.after_key = String(params[2]);
      return { rows: [], rowCount: 1 };
    }
    return clientQuery(sql);
  };
  const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
  const content = { query: async (sql: string) => {
    if (sql.includes('library_status')) return { rows: [], rowCount: 0 };
    if (sql.includes('also_enjoyed_source_fence')) return { rows: [{ revision: '1', changed: false }], rowCount: 1 };
    throw new Error(`unexpected content sql: ${sql.slice(0, 160)}`);
  }, connect: async () => { throw new Error('content connect'); } } as unknown as Pool;
  const store = new AlsoEnjoyedStore(pool, content, () => 1_700_000_000_000);
  const deps = workDeps(source, sparql => {
    if (sparql.includes('GlobalRatingObservationRevision')) {
      return { results: { bindings: [{ observation: { value: observation } }] } };
    }
    return { results: { bindings: [] } };
  });
  return { source, generation, store, deps };
}

test('co-reader build commits each phase while the graph moves and reaches complete within its bound', async () => {
  const run = coReaderHarness();
  const request = new Request('http://main.internal/co-reader-build');
  await run.store.advance('gen', automaticCoReaders, run.deps, request);
  expect(run.generation.phase).toBe('shelves');
  expect(run.generation.graph_sequence).toBe('4');
  expect(run.source.head).toBeGreaterThan(10n);
  let calls = 1;
  while (run.generation.phase !== 'complete' && calls < CO_READER_BOUND) {
    calls += 1;
    await run.store.advance('gen', automaticCoReaders, run.deps, request);
  }
  expect(run.generation.phase).toBe('complete');
  expect(calls).toBe(CO_READER_BOUND);
  expect(run.generation.graph_sequence).toBe('4');
});

test('co-reader refresh keeps its position pin when the sequence moves and still refuses another epoch', async () => {
  const source = movingSource(8n);
  const query = async (sql: string) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.startsWith('SET LOCAL')) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('recovery_fence')) return { rows: [{ open: true }], rowCount: 1 };
    if (sql.includes('derived_generation_head')) return { rows: [{ generation: 'gen', revision: '1',
      activated_at: new Date(1_700_000_000_000), graph_epoch: 'epoch', access_revision: '3',
      content_revision: '3' }], rowCount: 1 };
    if (sql.includes("state IN ('building','ready')")) return { rows: [], rowCount: 0 };
    if (sql.includes('also_enjoyed_source_fence')) return { rows: [{ revision: '3', changed: false }], rowCount: 1 };
    throw new Error(`unexpected refresh sql: ${sql.slice(0, 160)}`);
  };
  const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
  const store = new AlsoEnjoyedStore(pool, pool, () => 1_700_000_000_000);
  const deps = workDeps(source, () => { throw new Error('refresh has no graph page'); });
  await store.refresh(deps, new Request('http://main.internal/co-reader-refresh'));
  expect(source.reads).toBe(2);
  expect(source.head).toBe(10n);
  const closed = coReaderHarness();
  closed.source.epoch = 'restored';
  await expect(closed.store.advance('gen', automaticCoReaders, closed.deps, new Request('http://main.internal/co-reader-build')))
    .rejects.toBeInstanceOf(RecommendationRestart);
  expect(closed.generation.phase).toBe('ratings');
  closed.generation.phase = 'complete';
  await expect(closed.store.activate(automaticCoReaders, 'gen', null,
    { idempotencyKey: 'co-reader-activate', requestDigest: 'digest' },
    { dataEpoch: 'epoch', sequence: '3' })).rejects.toThrow('Co-reader generation source changed');
});

function catalogHarness(options: { hold?: boolean; changeEpoch?: boolean } = {}) {
  const source = movingSource(1n);
  source.hold = options.hold === true;
  const resources = Array.from({ length: CATALOG_RESOURCES }, (_, index) => realm(index + 1)).sort();
  const done: Array<[string, string]> = [];
  let checkpoint = '';
  const store = {
    purge: async () => {},
    catalog: async () => checkpoint,
    enroll: async () => {},
    catalogDone: async (prior: string, after: string) => { done.push([prior, after]); checkpoint = after; },
    claim: async () => null,
  };
  const deps = workDeps(source, sparql => {
    const match = sparql.match(/STR\(\?resource\) > ("(?:[^"\\]|\\.)*")/);
    const after = match ? JSON.parse(match[1]!) as string : '';
    const page = resources.filter(id => id > after).slice(0, DISCOVERY_REFRESH_COST.catalogSize + 1);
    return { results: { bindings: page.map(id => ({ resource: { value: id }, scope: { value: 'realm' },
      realm: { value: id } })) } };
  }, {
    relayPosition: { read: async () => ({ dataEpoch: source.epoch, sequence: (source.frozen
      ? source.head : source.head - 1n).toString() }) },
  } as Partial<MainWorkDependencies>);
  if (options.changeEpoch) {
    const fuseki = deps.environment.fuseki;
    deps.environment.fuseki = { query: async (sparql: string) => {
      if (!sparql.includes('routingEpoch')) return fuseki.query(sparql);
      source.reads += 1;
      const sequence = source.head;
      if (!source.frozen) source.head += 1n;
      const epoch = source.reads === 2 ? 'restored' : 'epoch';
      return { results: { bindings: [{ epoch: { value: epoch }, sequence: { value: sequence.toString() } }] } };
    } } as never;
  }
  const worker = new DiscoveryRefreshWorker(deps, store as never, {} as DiscoveryProjection);
  return { source, done, checkpoint: () => checkpoint, worker };
}

test('discovery catalog commits each keyset page while the graph moves and finishes within its bound', async () => {
  const run = catalogHarness();
  await run.worker.tick();
  expect(run.done).toHaveLength(1);
  expect(run.done[0]![0]).toBe('');
  const page = Array.from({ length: CATALOG_RESOURCES }, (_, index) => realm(index + 1)).sort();
  expect(run.done[0]![1]).toBe(page[DISCOVERY_REFRESH_COST.catalogSize - 1]);
  expect(run.source.head).toBeGreaterThan(1n);
  let calls = 1;
  while (run.checkpoint() !== '' && calls < CATALOG_BOUND) {
    calls += 1;
    await run.worker.tick();
  }
  expect(run.checkpoint()).toBe('');
  expect(calls).toBe(CATALOG_BOUND);
  expect(run.done[1]![1]).toBe('');
});

test('discovery catalog does not advance while the graph is held or its epoch changes', async () => {
  const held = catalogHarness({ hold: true });
  expect(await held.worker.tick()).toBe('idle');
  expect(held.done).toEqual([]);
  const restored = catalogHarness({ changeEpoch: true });
  await expect(restored.worker.tick()).rejects.toBeInstanceOf(WorkReadMoved);
  expect(restored.done).toEqual([]);
});
