import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  countedSample,
  countedViolations,
  type CountedCheck,
  type CountedValues,
} from '../../kernel/test/support/growth-counters.ts';
import { observeDumpRetention } from '../src/dumps-bytes.ts';
import { VndbTablesStore } from '../src/vndb-tables.ts';
import { createSqliteProbe } from './support/sqlite-growth.ts';

type Entry = Parameters<VndbTablesStore['stage']>[2] extends AsyncIterable<infer T> ? T : never;
const scales = [1, 8, 64];
const names = ['vn.header', 'vn', 'vn_titles.header', 'vn_titles', 'entry_meta.header', 'entry_meta'];
const fixtures = names.map((name) =>
  Uint8Array.from(readFileSync(new URL(`../../../specs/fixtures/imports/vndb-tables/db/${name}`, import.meta.url))),
);
type Sample = { scale: number; counted: ReturnType<typeof countedSample> };
const zero = { absolute: 0, relative: 0 };
const sqlCheck: CountedCheck = {
  read: (value) => value as CountedValues,
  bounds: { 'sqlite returned rows': 'constant', 'sqlite statements': 'constant' },
  slack: { 'sqlite returned rows': zero, 'sqlite statements': zero },
};
const bufferCheck: CountedCheck = {
  read: (value) => value as CountedValues,
  bounds: { 'line capacity bytes': 'constant', 'input backing bytes': 'constant' },
  slack: { 'line capacity bytes': zero, 'input backing bytes': zero },
};
const inputCheck: CountedCheck = {
  read: (value) => value as CountedValues,
  bounds: { 'input bytes': 'linear', 'entry and body events': 'linear' },
  slack: { 'input bytes': zero, 'entry and body events': zero },
};
const retentionCheck: CountedCheck = {
  read: (value) => value as CountedValues,
  bounds: { 'retained total bytes': 'constant' },
  slack: { 'retained total bytes': zero },
};
const counters = () => ({ entries: 0, bodies: 0, bytes: 0, closed: false, bodyClosed: 0, scans: 0 });
function entry(
  path: string,
  data: Uint8Array,
  count: ReturnType<typeof counters>,
  kind: Entry['kind'] = 'file',
): Entry {
  return {
    path,
    kind,
    declaredBytes: data.length,
    bytes: (async function* () {
      count.bodies++;
      try {
        for (let offset = 0; offset < data.length; offset += 128) {
          const chunk = Uint8Array.from(data.subarray(offset, offset + 128));
          Object.defineProperty(chunk, Symbol.iterator, {
            value: function* () {
              for (const byte of Uint8Array.prototype.values.call(chunk)) {
                count.scans++;
                yield byte;
              }
            },
          });
          count.bytes += chunk.length;
          yield chunk;
        }
      } finally {
        count.bodyClosed++;
      }
    })(),
  };
}
async function* archive(count: ReturnType<typeof counters>, reject = false) {
  try {
    // Data before headers exercises real bounded spool reads and deletion.
    for (const index of reject ? [1, 0, 3] : [1, 3, 5, 0, 2, 4]) {
      count.entries++;
      yield entry(`db/${names[index]}`, fixtures[index]!, count);
    }
    if (reject) {
      for (let i = 0; i < 4; i++) {
        count.entries++;
        yield entry('ignored/repeated', new Uint8Array(0), count, i % 2 ? 'directory' : 'file');
      }
    }
  } finally {
    count.closed = true;
  }
}

// Each synchronous native execution is measured across the actual async stage.
// Keep raw EQP evidence from createSqliteProbe, including rejection cleanup.
// This wrapper observes prepared statement methods, not direct db.run/db.exec calls.
function stageProbe(db: Database) {
  const probe = createSqliteProbe(db, { growingTables: ['vndb_table_runs', 'vndb_table_rows', 'vndb_table_spool'] });
  let active = false;
  let counts = { 'sqlite returned rows': 0, 'sqlite statements': 0 };
  const wrapped = new WeakSet<object>();
  for (const method of ['query', 'prepare'] as const) {
    const native = db[method];
    Object.defineProperty(db, method, {
      configurable: true,
      value: (...args: unknown[]) => {
        const statement = Reflect.apply(native, db, args);
        if (!wrapped.has(statement)) {
          wrapped.add(statement);
          for (const method of ['get', 'all', 'run', 'values', 'raw'] as const) {
            const execute = statement[method];
            Object.defineProperty(statement, method, {
              configurable: true,
              value: (...binds: unknown[]) => {
                if (!active) return Reflect.apply(execute, statement, binds);
                const sample = probe.measure(() => Reflect.apply(execute, statement, binds));
                counts['sqlite returned rows'] += sample.counts['sqlite returned rows'];
                counts['sqlite statements'] += sample.counts['sqlite statements'];
                return sample.value;
              },
            });
          }
        }
        return statement;
      },
    });
  }
  return async (operation: () => Promise<void>) => {
    counts = { 'sqlite returned rows': 0, 'sqlite statements': 0 };
    const before = probe.verifyPlans().length;
    active = true;
    try {
      await operation();
    } finally {
      active = false;
    }
    const evidence = probe.verifyPlans().slice(before);
    expect(evidence.length).toBe(counts['sqlite statements']);
    expect(counts['sqlite returned rows']).toBeGreaterThan(0);
    for (const event of evidence) {
      for (const row of event.plan) {
        expect(row.detail).not.toMatch(/SCAN|TEMP B-TREE|AUTOMATIC/i);
        expect(row.detail).toMatch(/USING (?:COVERING )?INDEX .*\(source=\? AND run_id=\?/);
      }
    }
    return { ...counts };
  };
}

// One seed algorithm grows all three relations in earlier same-source archives,
// other-source acquisitions and unrelated histories. Seed work is not measured.
function seed(db: Database, previous: number, scale: number) {
  for (const [source, prefix] of [
    ['vndb', 'old'],
    ['other', 'ready'],
    ['history', 'past'],
  ]) {
    const sequence = 'WITH RECURSIVE seq(n) AS (SELECT ? UNION ALL SELECT n+1 FROM seq WHERE n<?) ';
    const binds = [previous * 128 + 1, scale * 128, source!, prefix!];
    db.query(`${sequence}INSERT INTO vndb_table_runs (source,run_id,state,child_cap)
      SELECT ?, ? || n, 'ready', 64 FROM seq`).run(...binds);
    db.query(`${sequence}INSERT INTO vndb_table_rows
      SELECT ?, ? || n, 'vn', 'v' || n, n, '', json_object('id','v' || n) FROM seq`).run(...binds);
    db.query(`${sequence}INSERT INTO vndb_table_spool
      SELECT ?, ? || n, 'vn_titles', 1, x'00' FROM seq`).run(...binds);
  }
}

test('fixed admission rejection and ready staging keep exact-run SQL and live buffers constant over history', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'vndb-admission-'));
  const path = resolve(directory, 'state.sqlite');
  let db = new Database(path);
  const measure = stageProbe(db);
  const store = new VndbTablesStore(db, { maxArchiveEntries: 6, maxChunkBytes: 128 });
  const rejected: Sample[] = [],
    ready: Sample[] = [],
    memory: Sample[] = [];
  try {
    let previous = 0;
    for (const scale of scales) {
      seed(db, previous, scale);
      previous = scale;
      for (const reject of [true, false]) {
        const run = `${reject ? 'failed' : 'ready'}-${scale}`;
        store.begin('vndb', run);
        db.exec('ANALYZE');
        const count = counters();
        let input = 0,
          line = 0;
        const restore = observeDumpRetention((sample) => {
          input = Math.max(input, sample.input);
          line = Math.max(line, sample.line);
        });
        let counts;
        try {
          counts = await measure(async () => {
            const operation = store.stage('vndb', run, archive(count, reject));
            if (reject) await expect(operation).rejects.toThrow('VNDB table staging failed');
            else await operation;
          });
        } finally {
          restore();
        }
        (reject ? rejected : ready).push({ scale, counted: countedSample([counts]) });
        expect(count.closed).toBe(true);
        expect(count.entries).toBe(reject ? 7 : 6);
        expect(count.bodies).toBe(6);
        expect(count.bodyClosed).toBe(6);
        expect(count.bytes).toBe(
          (reject ? [1, 0, 3] : [0, 1, 2, 3, 4, 5]).reduce((sum, i) => sum + fixtures[i]!.length, 0),
        );
        expect(count.scans).toBe(count.bytes);
        expect(store.inspect('vndb', run).state).toBe(reject ? 'failed' : 'ready');
        if (reject) {
          expect(() => store.page('vndb', run, { after: null, limit: 1 })).toThrow();
          for (const table of ['vndb_table_rows', 'vndb_table_spool'])
            expect(db.query(`SELECT * FROM ${table} WHERE source=? AND run_id=?`).all('vndb', run)).toHaveLength(0);
        } else {
          expect(store.page('vndb', run, { after: null, limit: 16 }).records).toHaveLength(2);
          memory.push({
            scale,
            counted: countedSample([{ 'line capacity bytes': line, 'input backing bytes': input }]),
          });
          expect(line).toBe(64 * 1024);
          expect(input).toBe(128);
        }
      }
      for (const table of ['vndb_table_runs', 'vndb_table_rows', 'vndb_table_spool'])
        expect((db.query(`SELECT count(*) AS n FROM ${table} WHERE source='other'`).get() as { n: number }).n).toBe(
          scale * 128,
        );
    }
    for (const samples of [rejected, ready]) expect(countedViolations(sqlCheck, samples)).toEqual([]);
    expect(countedViolations(bufferCheck, memory)).toEqual([]);
    db.close();
    db = new Database(path);
    const reopened = new VndbTablesStore(db);
    expect(reopened.inspect('vndb', 'failed-64').state).toBe('failed');
    expect(() => reopened.page('vndb', 'failed-64', { after: null, limit: 1 })).toThrow();
    await expect(reopened.stage('vndb', 'failed-64', archive(counters()))).rejects.toThrow();
    expect(reopened.page('vndb', 'ready-64', { after: null, limit: 16 }).records).toHaveLength(2);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// Streaming a supplied archive once is O(admitted bytes + admitted entries),
// outside database measures. These are actual source/body pulls, not timing or heap estimates.
test('entry and byte populations stop exactly before the excessive body with linear admitted input', async () => {
  for (const mode of ['entries', 'bytes'] as const) {
    const input: Sample[] = [],
      memory: Sample[] = [];
    for (const scale of scales) {
      const db = new Database(':memory:');
      const budget = scale * 8;
      const store = new VndbTablesStore(
        db,
        mode === 'entries' ? { maxArchiveEntries: budget } : { maxArchiveBytes: budget, maxArchiveEntries: 2048 },
      );
      const count = counters();
      let peak = 0;
      const restore = observeDumpRetention((sample) => {
        peak = Math.max(peak, sample.total);
      });
      async function* supplied() {
        try {
          for (let i = 0; i < budget + 3; i++) {
            count.entries++;
            // Repeated user filenames and invalid UTF8 must never be scanned or decoded.
            const item = entry('db/users', new Uint8Array([255]), count);
            if (i === budget)
              Object.defineProperty(item, 'bytes', {
                get() {
                  count.bodies++;
                  throw new Error('excessive body opened');
                },
              });
            yield item;
          }
        } finally {
          count.closed = true;
        }
      }
      try {
        store.begin('vndb', 'budget');
        await expect(store.stage('vndb', 'budget', supplied())).rejects.toThrow();
        expect(count).toEqual({
          entries: budget + 1,
          bodies: budget,
          bytes: budget,
          closed: true,
          bodyClosed: budget,
          scans: 0,
        });
        input.push({
          scale,
          counted: countedSample([
            { 'input bytes': count.bytes, 'entry and body events': count.entries + count.bodies },
          ]),
        });
        memory.push({ scale, counted: countedSample([{ 'retained total bytes': peak }]) });
      } finally {
        restore();
        db.close();
      }
    }
    expect(countedViolations(inputCheck, input)).toEqual([]);
    expect(countedViolations(retentionCheck, memory)).toEqual([]);
  }
});

test('unsafe declarations, lying bodies and oversized backing close raw input without scanning or draining', async () => {
  for (const mode of [
    'unsafe',
    'overflow',
    'negative',
    'fractional',
    'infinite',
    'short',
    'lie',
    'mutated',
    'backing',
  ] as const) {
    const db = new Database(':memory:');
    const store = new VndbTablesStore(db, { maxArchiveBytes: 3, maxChunkBytes: 2 });
    const count = counters();
    let bodyTail = 0;
    async function* supplied() {
      try {
        count.entries++;
        yield entry('ignored/first', new Uint8Array([255, 255]), count);
        count.entries++;
        const item = entry('db/users', mode === 'short' ? new Uint8Array(0) : new Uint8Array([255, 255]), count);
        item.declaredBytes = {
          unsafe: Number.MAX_SAFE_INTEGER + 1,
          overflow: Number.MAX_SAFE_INTEGER,
          negative: -1,
          fractional: 0.5,
          infinite: Infinity,
          short: 1,
          lie: 1,
          mutated: 1,
          backing: 1,
        }[mode];
        if (mode === 'mutated')
          item.bytes = (async function* () {
            count.bodies++;
            try {
              item.declaredBytes = 2;
              yield new Uint8Array(2);
              bodyTail++;
              yield new Uint8Array(0);
            } finally {
              count.bodyClosed++;
            }
          })();
        if (mode === 'backing')
          item.bytes = (async function* () {
            count.bodies++;
            try {
              yield new Uint8Array(new ArrayBuffer(3), 0, 1);
            } finally {
              count.bodyClosed++;
            }
          })();
        yield item;
        count.entries++;
        throw new Error('tail must not be pulled');
      } finally {
        count.closed = true;
      }
    }
    try {
      store.begin('vndb', mode);
      await expect(store.stage('vndb', mode, supplied())).rejects.toThrow();
      expect(count.entries).toBe(2);
      expect(count.bodies).toBe(['short', 'lie', 'mutated', 'backing'].includes(mode) ? 2 : 1);
      expect(bodyTail).toBe(0);
      expect(count.bodyClosed).toBe(count.bodies);
      expect(count.closed).toBe(true);
      expect(count.scans).toBe(0);
      expect(store.inspect('vndb', mode).state).toBe('failed');
    } finally {
      db.close();
    }
  }
});

test('archive option validation precedes database setup and permits explicit hard bounds', () => {
  for (const key of ['maxArchiveBytes', 'maxArchiveEntries']) {
    for (const value of [null, NaN, Number.MAX_SAFE_INTEGER, '1']) {
      const db = new Database(':memory:');
      try {
        expect(() => new VndbTablesStore(db, { [key]: value })).toThrow();
        expect(db.query("SELECT name FROM sqlite_schema WHERE type='table'").all()).toHaveLength(0);
      } finally {
        db.close();
      }
    }
  }
  const db = new Database(':memory:');
  try {
    expect(() => new VndbTablesStore(db, { maxArchiveBytes: 64 * 1024 ** 3, maxArchiveEntries: 2048 })).not.toThrow();
  } finally {
    db.close();
  }
});
