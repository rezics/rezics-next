import { expect, test } from 'bun:test';
import type { Database, SQLQueryBindings } from 'bun:sqlite';
import { countedSample, countedViolations, type CountedCheck } from '../../kernel/test/support/growth-counters.ts';

import { createDumpCounters, MAX_DUMP_RECORD_BYTES } from '../src/dumps-bytes.ts';
import { readDump } from '../src/dumps.ts';
import { RUN_TABLES, RunStore, type Run, type SourceProjection } from '../src/run-store.ts';
import { createSqliteProbe } from './support/sqlite-growth.ts';

type Sample = { scale: number; counted: ReturnType<typeof countedSample> };

const constant: CountedCheck = {
  read: (value) => value as Record<string, number>,
  bounds: { 'sqlite returned rows': 'constant', 'sqlite statements': 'constant' },
};

const source = 'open-library';
const sizes = [72 * 1024, 144 * 1024, 288 * 1024];
const keys = sizes.map((_, i) => `/works/OL${100000 + i}W`);
function record(recordKey: string, description = '') {
  return {
    row: {
      source,
      recordKey,
      recordRevision: '7',
      digest: 'a'.repeat(64),
      converter_revision: 'record-cap@1',
      state: 'present' as const,
    },
    projection: { sourceKind: 'openlibrary' as const, normalizedRecord: { key: recordKey, description } },
  };
}
function begin(store: RunStore<SourceProjection>): Run {
  const run = store.begin(source);
  if (run === 'busy') throw new Error('Unexpected busy source');
  return run;
}

// One growing seed: current members/acknowledgements, failed history/activity,
// and unrelated entries in the active staging run all grow with scale.
function seed(store: RunStore<SourceProjection>, scale: number, previous: number): Run {
  const count = scale;
  for (let i = previous; i < count; i++) {
    const history = begin(store);
    store.stage(history, record(`History${i}`));
    expect(store.seal(history, { complete: false, reason: 'truncated' }).status).toBe('invalid-input');
  }
  const current = begin(store);
  for (let i = 0; i < count; i++) store.stage(current, record(`Current${i}`));
  expect(store.seal(current, { complete: true }).status).toBe('ready');
  for (let i = 0; i < count; i++) {
    store.classify(current, `Current${i}`, { commands: [] });
    store.acknowledgeNoEffects(current, `Current${i}`, { reason: 'no-owned-candidates' });
  }
  let result = store.finalize(current, 100);
  while (result === 'more') result = store.finalize(current, 100);
  expect(result).toBe('complete');
  expect(store.source(source).count).toBe(count);
  const run = begin(store);
  for (let i = 0; i < count; i++) store.stage(run, record(`Current${i}`));
  return run;
}

// Reuse the native execution/transaction/lazy-row probe, but defer its EQP
// calls. Fill its evidence arrays using actual bindings after measurement;
// neither ANALYZE nor EXPLAIN executes inside the measured operation.
function deferredProbe(database: Database) {
  const prepare = database.prepare;
  type Plan = { id: number; parent: number; notused: number; detail: string };
  const pending: { sql: string; bindings: SQLQueryBindings[]; plan: Plan[] }[] = [];
  const descriptor = Object.getOwnPropertyDescriptor(database, 'prepare');
  Object.defineProperty(database, 'prepare', {
    configurable: true,
    writable: true,
    value(sql: string, ...args: unknown[]) {
      if (!sql.startsWith('EXPLAIN QUERY PLAN ')) return Reflect.apply(prepare, database, [sql, ...args]);
      return {
        all(...bindings: SQLQueryBindings[]) {
          const plan: Plan[] = [];
          pending.push({ sql, bindings, plan });
          return plan;
        },
        finalize() {},
      };
    },
  });
  const probe = createSqliteProbe(database, { growingTables: RUN_TABLES });
  return {
    probe,
    verify() {
      // Replay every execution (and therefore every distinct SQL/binding pair).
      for (const event of pending.splice(0)) {
        const statement = prepare.call(database, event.sql);
        try {
          event.plan.push(...(statement.all(...event.bindings) as Plan[]));
        } finally {
          statement.finalize();
        }
      }
      probe.verifyPlans();
    },
    restore() {
      probe.restore();
      if (descriptor) Object.defineProperty(database, 'prepare', descriptor);
      else Reflect.deleteProperty(database, 'prepare');
    },
  };
}

test('larger sanitized record stage and exact key/page reads stay indexed as unrelated state grows', () => {
  const store = new RunStore<SourceProjection>(':memory:', { projectionMode: 'source-record' });
  const samples = new Map<string, Sample[]>();
  let previous = 0;
  let step = 0;
  let cumulative = 0;
  try {
    for (const scale of [64, 512, 4096]) {
      const run = seed(store, scale, previous);
      previous = scale;
      step++;
      cumulative += scale;
      expect(
        RUN_TABLES.map(
          (table) => (store.database.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n,
        ),
      ).toEqual([1, scale + 2 * step, scale + 2 * cumulative + 3 * (step - 1), scale, scale, 0, 0, 0]);
      store.database.exec('ANALYZE');
      const evidence = deferredProbe(store.database);
      const inputBytes: number[] = [];
      const outputBytes: number[] = [];
      const measure = <T>(name: string, operation: () => T) => {
        const sample = evidence.probe.measure(operation);
        evidence.verify();
        expect(sample.counts['sqlite returned rows']).toBeLessThanOrEqual(5);
        expect(sample.counts['sqlite statements']).toBeGreaterThan(0);
        expect(sample.counts['sqlite statements']).toBeLessThanOrEqual(9);
        const searches = sample.statements.flatMap((s) => s.plan).filter((p) => /^SEARCH\b/.test(p.detail));
        expect(searches.length).toBeGreaterThan(0);
        for (const search of searches) expect(search.detail).toMatch(/\(source=\?/);
        const group = samples.get(name) ?? [];
        group.push({ scale, counted: countedSample([sample.counts]) });
        samples.set(name, group);
        return sample;
      };
      try {
        for (const [i, size] of sizes.entries()) {
          const target = record(keys[i]!, 'é'.repeat(size / 2));
          inputBytes.push(Buffer.byteLength(JSON.stringify(target.projection.normalizedRecord)));
          const stage = measure(`stage-${size}`, () => store.stage(run, target));
          expect(stage.counts).toEqual({ 'sqlite returned rows': 1, 'sqlite statements': 6 });
          expect(stage.statements.filter((s) => s.kind === 'control').map((s) => s.sql)).toEqual([
            'BEGIN IMMEDIATE',
            'COMMIT',
          ]);
          const insert = stage.statements.find((s) => s.kind === 'insert')!;
          expect(insert.changes).toBe(1);
          expect(insert.parameters.slice(0, 3)).toEqual([source, run.id, target.row.recordKey]);
          const serialized = insert.parameters[4] as string;
          expect(JSON.parse(serialized)).toEqual(target.projection);
          outputBytes.push(Buffer.byteLength(serialized));
          const read = measure(`key-${size}`, () => store.key(source, target.row.recordKey, run));
          expect(read.value.staged).toEqual(target);
          expect(read.counts).toEqual({ 'sqlite returned rows': 3, 'sqlite statements': 5 });
        }
        expect(store.seal(run, { complete: true }).status).toBe('ready');
        for (const [i, size] of sizes.entries()) {
          const page = measure(`page-${size}`, () =>
            store.pageStaged(run, {
              ...(i ? { after: keys[i - 1]! } : {}),
              limit: 1,
            }),
          );
          expect(page.counts).toEqual({ 'sqlite returned rows': 2, 'sqlite statements': 2 });
          expect(page.value).toEqual([record(keys[i]!, 'é'.repeat(size / 2))]);
          expect(Buffer.byteLength(JSON.stringify(page.value[0]!.projection))).toBe(outputBytes[i]!);
          const details = page.statements
            .flatMap((s) => s.plan)
            .map((p) => p.detail)
            .join('\n');
          expect(details).toMatch(/SEARCH run_entries USING PRIMARY KEY \(source=\? AND run_id=\?/);
          if (i) expect(details).toContain('record_key>?');
        }
        // Exact byte deltas prove linear serialization in M, independently of N/activity.
        const wrapper = Buffer.byteLength('{"sourceKind":"openlibrary","normalizedRecord":}');
        for (let i = 0; i < sizes.length; i++) {
          expect(inputBytes[i]! - sizes[i]!).toBe(inputBytes[0]! - sizes[0]!);
          expect(outputBytes[i]! - inputBytes[i]!).toBe(wrapper);
        }
      } finally {
        evidence.restore();
      }
      expect(store.abandon(run)).toBe('abandoned');
    }
    for (const group of samples.values()) expect(countedViolations(constant, group)).toEqual([]);
  } finally {
    store.close();
  }
});

test('one-record acquisition has linear actual parser work outside database measures', async () => {
  for (const size of sizes) {
    const payload = { id: 'Q1', type: 'item', description: 'é'.repeat(size / 2) };
    const json = JSON.stringify(payload);
    const bytes = new TextEncoder().encode(`[\r\n${json}\r\n]\r\n`);
    const counters = createDumpCounters();
    let closed = false;
    async function* input() {
      try {
        for (let offset = 0; offset < bytes.length; offset += 16384) yield bytes.slice(offset, offset + 16384);
      } finally {
        closed = true;
      }
    }
    const rows = [];
    for await (const row of readDump('wikidata', input(), { maxRecordBytes: MAX_DUMP_RECORD_BYTES, counters }))
      rows.push(row);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toEqual(payload);
    expect(closed).toBe(true);
    expect(counters.yieldedRecords).toBe(1);
    expect(counters.pulledBytes).toBe(bytes.length);
    expect(counters.scannedBytes).toBe(bytes.length);
    expect(counters.pulledChunks).toBe(Math.ceil(bytes.length / 16384));
    expect(counters.copiedBytes).toBeGreaterThanOrEqual(bytes.length);
    expect(counters.copiedBytes).toBeLessThanOrEqual(4 * bytes.length);
    expect(counters.peakBufferBytes).toBeLessThanOrEqual(2 * bytes.length);
  }
});

test('hard projection cap counts serialized record bytes independently of its fixed wrapper', () => {
  const store = new RunStore<SourceProjection>(':memory:', { projectionMode: 'source-record' });
  const legacy = new RunStore(':memory:');
  try {
    const run = begin(store);
    const target = record(keys[0]!);
    const normalizedRecord = 'é'.repeat((MAX_DUMP_RECORD_BYTES - 2) / 2);
    store.stage(run, { ...target, projection: { ...target.projection, normalizedRecord } });
    expect(store.key(source, keys[0]!, run).staged?.projection.normalizedRecord).toBe(normalizedRecord);
    let invoked = 0;
    const getter = Object.defineProperty({}, 'description', {
      enumerable: true,
      get() {
        invoked++;
        return '';
      },
    });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    let deep: unknown = null;
    for (let i = 0; i < 66; i++) deep = { child: deep };
    for (const invalid of [
      'x'.repeat(MAX_DUMP_RECORD_BYTES - 1),
      '\0'.repeat(Math.floor(MAX_DUMP_RECORD_BYTES / 6) + 1),
      getter,
      cycle,
      deep,
    ])
      expect(() =>
        store.stage(run, {
          ...record(keys[1]!),
          projection: { sourceKind: 'openlibrary', normalizedRecord: invalid },
        }),
      ).toThrow();
    expect(invoked).toBe(0);
    expect(store.key(source, keys[1]!, run).staged).toBeNull();
    const legacyRun = legacy.begin(source);
    if (legacyRun === 'busy') throw new Error('Unexpected busy source');
    // The statements-only serialization budget remains 64 KiB.
    const statement = {
      property: { id: 'schema:name' },
      value: { type: 'value' as const, content: 'Title' },
      references: [
        {
          parts: [
            { property: { id: 'schema:sameAs' }, value: { type: 'value' as const, content: 'https://example.org/' } },
          ],
        },
      ],
    };
    legacy.stage(legacyRun, { row: target.row, projection: [statement] });
    expect(() =>
      legacy.stage(legacyRun, {
        row: record(keys[1]!).row,
        projection: Array.from({ length: 1024 }, () => statement),
      }),
    ).toThrow();
  } finally {
    store.close();
    legacy.close();
  }
});

test('record boundaries retain native framing overhead, UTF-8 accounting and upstream cleanup', async () => {
  const json = JSON.stringify({ id: 1, type: 2, name: '雪é' });
  const wiki = JSON.stringify({ id: 'Q1', type: 'item', name: '雪é' });
  const copy = 'v1\t雪é';
  const ol = `/type/work\t/works/OL1W\t7\t2025-01-01\t${JSON.stringify({
    type: { key: '/type/work' },
    key: '/works/OL1W',
    revision: 7,
    title: '雪é',
  })}`;
  const fixtures = [
    { source: 'bangumi', record: json, text: `${json}\r\n`, count: 1 },
    { source: 'wikidata', record: wiki, text: `[\r\n${wiki},\r\n${wiki}\r\n]\r\n`, count: 2 },
    {
      source: 'vndb',
      record: copy,
      text: `COPY public.vn (id, description) FROM stdin;\r\n${copy}\r\n\\.\r\n`,
      count: 1,
    },
    { source: 'openlibrary', record: ol, text: `${ol}\r\n`, count: 1 },
  ] as const;
  for (const fixture of fixtures) {
    for (const delta of [0, -1]) {
      let closed = false;
      async function* input() {
        try {
          const bytes = new TextEncoder().encode(fixture.text);
          for (let i = 0; i < bytes.length; i++) yield bytes.slice(i, i + 1);
        } finally {
          closed = true;
        }
      }
      const drain = async () => {
        let count = 0;
        for await (const _row of readDump(fixture.source, input(), {
          maxRecordBytes: Buffer.byteLength(fixture.record) + delta,
        }))
          count++;
        return count;
      };
      if (delta === 0) expect(await drain()).toBe(fixture.count);
      else await expect(drain()).rejects.toBeInstanceOf(Error);
      expect(closed).toBe(true);
    }
  }
});
