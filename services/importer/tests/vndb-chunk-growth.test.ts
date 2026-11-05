import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import {
  countedSample,
  countedViolations,
  type CountedCheck,
  type CountedSample,
  type CountedValues,
} from '../../kernel/test/support/growth-counters.ts';
import { DEFAULT_DUMP_CHUNK_BYTES, MAX_DUMP_CHUNK_BYTES, observeDumpRetention } from '../src/dumps-bytes.ts';
import { VndbTablesStore } from '../src/vndb-tables.ts';
import { createSqliteProbe } from './support/sqlite-growth.ts';

const names = ['vn.header', 'vn', 'vn_titles.header', 'vn_titles', 'entry_meta.header', 'entry_meta'];
const encode = (text: string) => new TextEncoder().encode(text);
const fixture = (name: string) =>
  readFileSync(new URL(`../../../specs/fixtures/imports/vndb-tables/db/${name}`, import.meta.url), 'utf8');
type Sample = { scale: number; counted: CountedSample };
const sqlCheck: CountedCheck = {
  read: (value) => value as CountedValues,
  bounds: { 'sqlite returned rows': 'constant', 'sqlite statements': 'constant' },
  slack: {
    'sqlite returned rows': { absolute: 2, relative: 0.1 },
    'sqlite statements': { absolute: 0, relative: 0 },
  },
};
const inputCheck: CountedCheck = {
  read: (value) => value as CountedValues,
  bounds: { 'input byte visits': 'linear', 'input chunks': 'linear', 'admitted input bytes': 'linear' },
  slack: {
    'input byte visits': { absolute: 2, relative: 0.1 },
    'input chunks': { absolute: 0, relative: 0 },
    'admitted input bytes': { absolute: 4, relative: 0.5 },
  },
};
type Entry = Parameters<VndbTablesStore['stage']>[2] extends AsyncIterable<infer T> ? T : never;
function entry(path: string, bytes: AsyncIterable<Uint8Array>, declaredBytes: number): Entry {
  return { path, kind: 'file', declaredBytes, bytes };
}
async function* archive(vn = fixture('vn'), size = 128, visit = (_byte: number) => {}, pull = (_bytes: number) => {}) {
  for (const name of names) {
    const data = encode(name === 'vn' ? vn : fixture(name));
    yield entry(
      `db/${name}`,
      (async function* () {
        for (let offset = 0; offset < data.length; offset += size) {
          const chunk = Uint8Array.from(data.subarray(offset, offset + size));
          Object.defineProperty(chunk, Symbol.iterator, {
            value: function* () {
              for (let index = 0; index < chunk.length; index++) {
                visit(chunk[index]!);
                yield chunk[index]!;
              }
            },
          });
          pull(chunk.byteLength);
          yield chunk;
        }
      })(),
      data.length,
    );
  }
}

// The shared probe measures synchronous executions. Wrap each execution, keeping
// its real SQL, binds, returned rows and EQP evidence across stage's await points.
function stageProbe(db: Database) {
  const probe = createSqliteProbe(db, {
    growingTables: ['vndb_table_runs', 'vndb_table_rows', 'vndb_table_spool'],
  });
  let active = false;
  let counts = { 'sqlite returned rows': 0, 'sqlite statements': 0 };
  const capture = <T>(operation: () => T): T => {
    if (!active) return operation();
    const sample = probe.measure(operation);
    counts['sqlite returned rows'] += sample.counts['sqlite returned rows'];
    counts['sqlite statements'] += sample.counts['sqlite statements'];
    return sample.value;
  };
  const seen = new WeakSet<object>();
  for (const method of ['query', 'prepare'] as const) {
    const original = db[method];
    Object.defineProperty(db, method, {
      configurable: true,
      value: (...args: unknown[]) => {
        const statement = Reflect.apply(original, db, args);
        if (!seen.has(statement)) {
          seen.add(statement);
          for (const execute of ['get', 'all', 'run', 'values', 'raw'] as const) {
            const native = statement[execute];
            Object.defineProperty(statement, execute, {
              configurable: true,
              value: (...binds: unknown[]) => capture(() => Reflect.apply(native, statement, binds)),
            });
          }
        }
        return statement;
      },
    });
  }
  for (const method of ['run', 'exec'] as const) {
    const native = db[method];
    Object.defineProperty(db, method, {
      configurable: true,
      value: (...args: unknown[]) => capture(() => Reflect.apply(native, db, args)),
    });
  }
  return {
    async measure(operation: () => Promise<void>) {
      counts = { 'sqlite returned rows': 0, 'sqlite statements': 0 };
      const before = probe.verifyPlans().length;
      active = true;
      try {
        await operation();
        expect(counts['sqlite returned rows']).toBeGreaterThan(0);
        expect(counts['sqlite statements']).toBeGreaterThan(0);
        expect(probe.verifyPlans().length - before).toBe(counts['sqlite statements']);
        return { ...counts };
      } finally {
        active = false;
      }
    },
  };
}

test('raw six-entry staging SQL stays constant across accumulated native keys and source history', async () => {
  const db = new Database(':memory:');
  const probe = stageProbe(db);
  const store = new VndbTablesStore(db);
  const samples: Sample[] = [];
  try {
    let previous = 0;
    for (const scale of [32, 128, 512]) {
      // Seed real ready archives in the same source and SQLite handle, retaining
      // every earlier run and native key as the next scale is added.
      for (let index = previous; index < scale; index++) {
        const run = `history-${index}`;
        store.begin('vndb', run);
        await store.stage('vndb', run, archive());
      }
      previous = scale;
      const run = `measured-${scale}`;
      store.begin('vndb', run);
      db.exec('ANALYZE');
      const counts = await probe.measure(() => store.stage('vndb', run, archive()));
      expect(store.inspect('vndb', run)).toMatchObject({ state: 'ready', stagedRows: 7 });
      samples.push({ scale, counted: countedSample([sqlCheck.read(counts, scale)]) });
    }
    expect(countedViolations(sqlCheck, samples)).toEqual([]);
  } finally {
    db.close();
  }
});

test('native input visits grow linearly over 1/8/64 owned chunks with bounded admitted backing', async () => {
  const db = new Database(':memory:');
  const probe = stageProbe(db);
  const store = new VndbTablesStore(db, { maxChunkBytes: 512 });
  const input: Sample[] = [];
  const sql: Sample[] = [];
  try {
    for (const scale of [1, 8, 64]) {
      const original = fixture('vn');
      const sentinel = 'UNLICENSED_DESCRIPTION_SENTINEL';
      const vn = original.replace(sentinel, 'x'.repeat(scale * 512 - encode(original).length + sentinel.length));
      let visits = 0;
      let pulls = 0;
      let pulledBytes = 0;
      let admitted = 0;
      let chunks = 0;
      let peak = 0;
      const restore = observeDumpRetention((sample) => {
        if (sample.input) {
          chunks++;
          admitted += sample.input;
          peak = Math.max(peak, sample.input);
        }
        expect(sample.input).toBeLessThanOrEqual(512);
        expect(sample.line).toBeLessThanOrEqual(64 * 1024);
      });
      const run = `bytes-${scale}`;
      store.begin('vndb', run);
      db.exec('ANALYZE');
      try {
        const counts = await probe.measure(() =>
          store.stage(
            'vndb',
            run,
            archive(
              vn,
              512,
              () => visits++,
              (bytes) => {
                pulls++;
                pulledBytes += bytes;
              },
            ),
          ),
        );
        sql.push({ scale, counted: countedSample([sqlCheck.read(counts, scale)]) });
      } finally {
        restore();
      }
      const expected = names.reduce((sum, name) => sum + encode(name === 'vn' ? vn : fixture(name)).length, 0);
      expect(admitted).toBe(expected);
      expect(visits).toBe(expected);
      expect(pulledBytes).toBe(expected);
      expect(pulls).toBe(chunks);
      expect(chunks).toBe(scale + 5);
      expect(peak).toBe(512);
      expect(store.page('vndb', run, { after: null, limit: 16 }).records).toHaveLength(2);
      input.push({
        scale,
        counted: countedSample([
          inputCheck.read(
            { 'input byte visits': visits, 'input chunks': chunks, 'admitted input bytes': admitted },
            scale,
          ),
        ]),
      });
    }
    expect(countedViolations(inputCheck, input)).toEqual([]);
    expect(countedViolations(sqlCheck, sql)).toEqual([]);
  } finally {
    db.close();
  }
});

test('chunk configuration only lowers the shared default and is rejected before any stream pull', () => {
  const db = new Database(':memory:');
  let pulled = 0;
  async function* entries() {
    pulled++;
    yield* archive();
  }
  try {
    for (const cap of [
      0,
      -1,
      0.5,
      NaN,
      Infinity,
      DEFAULT_DUMP_CHUNK_BYTES + 1,
      MAX_DUMP_CHUNK_BYTES,
      MAX_DUMP_CHUNK_BYTES + 1,
    ]) {
      expect(() => {
        const store = new VndbTablesStore(db, { maxChunkBytes: cap });
        store.begin('vndb', 'invalid');
        return store.stage('vndb', 'invalid', entries());
      }).toThrow();
    }
    expect(pulled).toBe(0);
  } finally {
    db.close();
  }
});

test('late oversized known/header/ignored backings fail before byte access and erase staged rows', async () => {
  const db = new Database(':memory:');
  const store = new VndbTablesStore(db);
  try {
    store.begin('vndb', 'baseline');
    await store.stage('vndb', 'baseline', archive());
    const baseline = store.page('vndb', 'baseline', { after: null, limit: 16 });
    let index = 0;
    for (const path of ['db/vn', 'db/vn.header', 'db/user_posts'])
      for (const cap of [128, DEFAULT_DUMP_CHUNK_BYTES]) {
        const current = cap === 128 ? new VndbTablesStore(db, { maxChunkBytes: cap }) : store;
        const run = `bad-${++index}`;
        let visits = 0;
        let closed = false;
        let resumed = false;
        const chunk = new Uint8Array(new ArrayBuffer(cap + 1), 0, 1);
        Object.defineProperty(chunk, Symbol.iterator, {
          value: function* () {
            visits++;
            yield 10;
          },
        });
        current.begin('vndb', run);
        const entries = (async function* () {
          for await (const item of archive()) {
            if (item.path === path) continue;
            yield item;
          }
          yield entry(
            path,
            (async function* () {
              try {
                yield chunk;
                resumed = true;
              } finally {
                closed = true;
              }
            })(),
            1,
          );
        })();
        await expect(current.stage('vndb', run, entries)).rejects.toThrow('VNDB table staging failed');
        expect(visits).toBe(0);
        expect(closed).toBe(true);
        expect(resumed).toBe(false);
        expect(current.inspect('vndb', run)).toEqual({
          state: 'failed',
          stagedRows: 0,
          stagedBytes: 0,
          sourceRecords: 0,
        });
        expect(() => current.page('vndb', run, { after: null, limit: 1 })).toThrow();
        for (const table of ['vndb_table_rows', 'vndb_table_spool'])
          expect(db.query(`SELECT 1 FROM ${table} WHERE source=? AND run_id=?`).get('vndb', run)).toBeNull();
        expect(store.page('vndb', 'baseline', { after: null, limit: 16 })).toEqual(baseline);
      }
  } finally {
    db.close();
  }
});

test('ignored invalid UTF8 streams larger than the hard chunk bound discard without scanning or persistence', async () => {
  const db = new Database(':memory:');
  const store = new VndbTablesStore(db);
  let pulled = 0;
  try {
    store.begin('vndb', 'ignored');
    await store.stage(
      'vndb',
      'ignored',
      (async function* () {
        yield* archive();
        yield entry(
          'db/user_posts',
          (async function* () {
            for (let index = 0; index < 8; index++) {
              const chunk = new Uint8Array(DEFAULT_DUMP_CHUNK_BYTES).fill(255);
              Object.defineProperty(chunk, Symbol.iterator, {
                value: () => {
                  throw new Error('Ignored bytes were scanned');
                },
              });
              pulled++;
              yield chunk;
            }
          })(),
          8 * DEFAULT_DUMP_CHUNK_BYTES,
        );
      })(),
    );
    expect(pulled).toBe(8);
    expect(store.inspect('vndb', 'ignored')).toMatchObject({ state: 'ready', stagedRows: 7, sourceRecords: 2 });
    expect(db.query('SELECT 1 FROM vndb_table_spool WHERE source=? AND run_id=?').get('vndb', 'ignored')).toBeNull();
  } finally {
    db.close();
  }
});
