import { afterEach, beforeEach, expect, test } from 'bun:test';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertGrowth, type GrowthSample } from '../services/kernel/test/support/growth-bound';
import { costOf, isControlStatement } from '../services/kernel/test/support/growth-cost';
import type { Counters, Fixture, ImportGrowthDriver, Scenario, Seed, SqliteStatement } from './imports-growth-driver';

const scales = Object.freeze([32, 128, 512] as const);
const B = 8;
const RECORD_CAP = 65536;
let driver: ImportGrowthDriver | undefined;
beforeEach(async () => {
  const path = process.env.IMPORT_GROWTH_DRIVER;
  if (!path) throw new Error('IMPORT_GROWTH_DRIVER is required: bind real import path counters');
  if (!isAbsolute(path) && !path.startsWith('file:')) throw new Error('Expected absolute import growth driver path');
  const url = isAbsolute(path) ? pathToFileURL(path) : new URL(path);
  if (url.protocol !== 'file:') throw new Error('Expected local import growth driver');
  const binding = await import(url.href);
  driver = await binding.createImportGrowthDriver();
});
afterEach(async () => {
  const closing = driver;
  driver = undefined;
  await closing?.close();
});
function d(): ImportGrowthDriver {
  if (!driver) throw new Error('IMPORT_GROWTH_DRIVER is required: bind real import path counters');
  return driver;
}
function integer(value: number) {
  expect(Number.isSafeInteger(value)).toBe(true);
  expect(value).toBeGreaterThanOrEqual(0);
}
function common(c: Counters) {
  for (const value of [c.networkRequests, c.workUnits, c.allocatedBytes, c.peakRetainedBytes, c.peakRetainedRecords])
    integer(value);
}
function pure(c: Counters, bytes: number, fields: number) {
  common(c);
  expect(c.partitions).toEqual([]);
  expect(c.statements).toEqual([]);
  expect(c.networkRequests).toBe(0);
  expect(c.workUnits).toBeGreaterThan(0);
  expect(c.workUnits).toBeLessThanOrEqual(64 * (bytes + fields));
  expect(c.allocatedBytes).toBeGreaterThan(0);
  expect(c.allocatedBytes).toBeLessThanOrEqual(64 * (bytes + fields));
  expect(c.peakRetainedBytes).toBeLessThanOrEqual(64 * (Math.min(bytes, RECORD_CAP) + fields));
}
// Test support only: raw plans and declared schema prove SQLite access bounds;
// returned rows alone cannot reveal a full scan that returns one aggregate row.
function sqliteKeyProof(statement: SqliteStatement, c: Counters) {
  expect(c.sqlite.analyzed).toBe(true);
  expect(c.sqlite.growingRelations.length).toBeGreaterThan(0);
  expect(statement.parameters).toBeDefined();
  for (const value of Object.values(statement.parameters))
    expect(value === null || ['string', 'number', 'bigint'].includes(typeof value) || value instanceof Uint8Array).toBe(
      true,
    );
  integer(statement.rowsReturned);
  if (statement.changes !== undefined) integer(statement.changes);
  const plan = JSON.parse(statement.explain) as { id: number; parent: number; detail: string }[];
  expect(Array.isArray(plan)).toBe(true);
  for (const row of plan) {
    integer(row.id);
    integer(row.parent);
    expect(typeof row.detail).toBe('string');
    expect(row.detail).not.toMatch(/\bSCAN\b|USE TEMP B-TREE|AUTOMATIC/i);
  }
  if (statement.classification === 'transaction-control') {
    expect(statement.sql).toMatch(
      /^\s*(?:BEGIN(?:\s+(?:DEFERRED|IMMEDIATE|EXCLUSIVE))?(?:\s+TRANSACTION)?|COMMIT|END|ROLLBACK(?:\s+TO(?:\s+SAVEPOINT)?\s+[\w]+)?|SAVEPOINT\s+[\w]+|RELEASE(?:\s+SAVEPOINT)?\s+[\w]+)\s*;?\s*$/i,
    );
    expect(plan).toEqual([]);
    expect(statement.reads).toEqual([]);
    expect(statement.rowsReturned).toBe(0);
    return;
  }
  if (statement.classification === 'keyed-insert') {
    // A single VALUES tuple bound on a declared unique key has no read plan.
    // INSERT SELECT, UPSERT subqueries, UPDATE and DELETE get no spelling exemption.
    const insert =
      /^\s*INSERT(?:\s+OR\s+(?:IGNORE|ABORT|FAIL|ROLLBACK))?\s+INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)\s*;?\s*$/i.exec(
        statement.sql,
      );
    expect(insert).not.toBeNull();
    const table = c.sqlite.growingRelations.find((r) => r.table === insert![1]);
    expect(table).toBeDefined();
    const columns = insert![2]!.split(',').map((v) => v.trim());
    const values = insert![3]!.split(',').map((v) => v.trim());
    expect(values.length).toBe(columns.length);
    for (const value of values) expect(value).toMatch(/^(?:\?\d*|[:@$]\w+)$/);
    const keys = table!.indexes.filter((index) => index.unique).map((index) => index.columns);
    if (table!.integerPrimaryKey) keys.push([table!.integerPrimaryKey]);
    expect(keys.some((key) => key.length > 0 && key.every((column) => columns.includes(column)))).toBe(true);
    expect(plan).toEqual([]);
    expect(statement.reads).toEqual([]);
    return;
  }
  expect(statement.classification).toBe('readable');
  expect(plan.length).toBeGreaterThan(0);
  const searches = plan.filter((row) => /^SEARCH /i.test(row.detail));
  for (const read of statement.reads) {
    const table = c.sqlite.growingRelations.find((r) => r.table === read.table);
    expect(table).toBeDefined();
    const nodes = searches.filter((row) => row.detail.split(/\s+/)[1] === read.alias);
    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) {
      const access = / USING (?:COVERING )?(?:INDEX (\S+)|INTEGER PRIMARY KEY) \((.+)\)$/i.exec(node.detail);
      expect(access).not.toBeNull();
      const index = table!.indexes.find((i) => i.name === access![1]);
      if (access![1]) expect(index).toBeDefined();
      else expect(table!.integerPrimaryKey).toBeTruthy();
      const prefix = index?.columns[0] ?? 'rowid';
      const first = access![2]!.split(/ AND /i)[0]!;
      expect(first).toMatch(/^[\w]+\s*(?:=|>|<|>=|<=)\s*\?$/);
      expect(first.split(/\s*[=<>]/)[0]).toBe(prefix);
    }
  }
  // No growing access node may escape the metadata proof, including join aliases.
  for (const node of searches) {
    const alias = node.detail.split(/\s+/)[1];
    expect(statement.reads.some((read) => read.alias === alias)).toBe(true);
  }
}
function database(c: Counters, fixture: Fixture, seed: Seed, items = 1) {
  common(c);
  expect(c.statements.length).toBeGreaterThan(0);
  expect(c.statements.length).toBeLessThanOrEqual(24 * items);
  expect(fixture.partitions.length).toBeLessThanOrEqual(4 * items);
  expect(new Set(c.partitions).size).toBeLessThanOrEqual(4 * items);
  for (const partition of c.partitions) expect(fixture.partitions).toContain(partition);
  let returned = 0,
    sqliteStatements = 0;
  const postgresStatements = c.statements.filter((s) => s.engine === 'postgres');
  expect(c.postgres.statements).toEqual(postgresStatements.map((s) => s.sql));
  for (const statement of postgresStatements)
    if (statement.explain) expect(c.postgres.plans).toContainEqual(JSON.parse(statement.explain));
  for (const statement of c.statements) {
    expect(statement.sql.length).toBeGreaterThan(0);
    expect(statement.sql).not.toMatch(/\bcount\s*\(/i);
    if (statement.engine === 'sqlite') {
      sqliteKeyProof(statement, c);
      returned += statement.rowsReturned;
      sqliteStatements++;
    } else {
      expect(statement.engine).toBe('postgres');
      integer(statement.rowsAppended);
      if (!statement.explain) {
        expect(isControlStatement(statement.sql)).toBe(true);
        continue;
      }
    }
  }
  // auto_explain also emits nested plans without a separate client query call.
  // Check every raw plan rather than silently dropping nested authorization work.
  for (const document of c.postgres.plans) {
    const walk = (node: Record<string, unknown>) => {
      const type = String(node['Node Type'] ?? '');
      if (/Scan/.test(type)) {
        expect(type).toMatch(/^Index(?: Only)? Scan$/);
        expect(String(node['Index Cond'] ?? '')).not.toBe('');
      }
      for (const child of (node.Plans ?? []) as Record<string, unknown>[]) walk(child);
    };
    const roots = (Array.isArray(document) ? document : [document]) as { Plan: Record<string, unknown> }[];
    for (const root of roots) {
      expect(root.Plan).toBeDefined();
      walk(root.Plan);
    }
    expect(JSON.stringify(document)).toContain('Actual Rows');
    expect(JSON.stringify(document)).toContain('Shared Hit Blocks');
  }
  const postgres = costOf(c.postgres); // actual examined rows, inclusive shared hits + reads
  expect(returned).toBeLessThanOrEqual(64 * (items + seed.fields));
  expect(postgres.rows + postgresStatements.reduce((sum, s) => sum + s.rowsAppended, 0)).toBeLessThanOrEqual(
    64 * (items + seed.fields),
  );
  expect(c.networkRequests).toBeLessThanOrEqual(8 * items);
  expect(c.allocatedBytes).toBeLessThanOrEqual(64 * (items * RECORD_CAP + seed.fields * 1024));
  expect(c.peakRetainedBytes).toBeLessThanOrEqual(4 * (B * RECORD_CAP + seed.fields * 1024));
  expect(c.peakRetainedRecords).toBeLessThanOrEqual(seed.scenario === 'bulk' ? items : B);
  return {
    // blocks:0 means unavailable SQLite buffers, not zero physical I/O.
    sqlite: { rows: returned, blocks: 0, statements: sqliteStatements },
    postgres,
  };
}
const options = (scenario: Scenario, n = 32, history = 32, fields = 1): Seed =>
  Object.freeze({ n, history, fields, scenario, source: 'growth-source', key: 'fixed-record' });

async function converters(index: number, oversized?: 'bytes' | 'fields') {
  const inputs = new Map<number, string>();
  // Vary N, U x t and M independently; never inflate the measured payload with N.
  for (const axis of ['n', 'history', 'fields'] as const)
    for (const scale of scales) {
      const seed = { ...options('changed'), [axis]: scale };
      const fixture = await d().seed(seed);
      expect(new Set(fixture.converters.map((c) => c.exportPath)).size).toBe(4);
      const converter = fixture.converters[index]!;
      const input =
        oversized === 'bytes'
          ? converter.oversized
          : oversized === 'fields'
            ? converter.tooManyFields
            : converter.input;
      if (oversized === 'bytes') expect(input.byteLength).toBeGreaterThan(RECORD_CAP);
      else expect(input.byteLength).toBeLessThanOrEqual(RECORD_CAP);
      const signature = `${converter.exportPath}:${Buffer.from(input).toString('base64')}`;
      if (inputs.has(seed.fields)) expect(signature).toBe(inputs.get(seed.fields)!);
      inputs.set(seed.fields, signature);
      const result = await d().measure(() => d().run({ kind: 'convert', exportPath: converter.exportPath, input }));
      expect(result.value.status).toBe(oversized ? 'record-too-large' : 'completed');
      pure(result.counters, oversized === 'bytes' ? RECORD_CAP + 1 : input.byteLength, seed.fields);
    }
}
test('first independent converter has bounded record work and zero database or network access', async () => {
  await converters(0);
});
test('second independent converter has bounded record work and zero database or network access', async () => {
  await converters(1);
});
test('third independent converter has bounded record work and zero database or network access', async () => {
  await converters(2);
});
test('fourth independent converter has bounded record work and zero database or network access', async () => {
  await converters(3);
});
test('all four converters reject oversized records within the hard record budget', async () => {
  for (let index = 0; index < 4; index++) {
    await converters(index, 'bytes');
    await converters(index, 'fields');
  }
});

async function streaming() {
  let fixedRecord: string | undefined;
  for (const axis of ['n', 'history', 'supplied'] as const)
    for (const scale of scales) {
      const fixture = await d().seed({ ...options('unchanged'), ...(axis === 'supplied' ? {} : { [axis]: scale }) });
      const record = fixture.dumpRecord;
      const signature = Buffer.from(record).toString('base64');
      if (fixedRecord !== undefined) expect(signature).toBe(fixedRecord);
      fixedRecord = signature;
      expect(record.byteLength).toBeGreaterThan(0);
      expect(record.byteLength).toBeLessThanOrEqual(1024);
      const supplied = axis === 'supplied' ? scale : 32;
      let opened = 0,
        read = 0,
        yielded = 0;
      const input: AsyncIterable<Uint8Array> = {
        async *[Symbol.asyncIterator]() {
          expect(++opened).toBe(1);
          for (let i = 0; i < supplied; i++) {
            read++;
            yield record.slice();
          }
        },
      };
      const result = await d().measure(async () => {
        for await (const _record of d().stream(input, { pageCap: B, recordByteCap: RECORD_CAP })) {
          yielded++;
          if (yielded === 1) expect(read).toBeLessThan(supplied);
          expect(read - yielded).toBeLessThanOrEqual(B);
        }
      });
      expect(opened).toBe(1);
      expect(read).toBe(supplied);
      expect(yielded).toBe(supplied);
      pure(result.counters, supplied * record.byteLength, supplied);
      expect(result.counters.peakRetainedRecords).toBeLessThanOrEqual(B);
      expect(result.counters.peakRetainedBytes).toBeLessThanOrEqual((B + 1) * record.byteLength);
    }
}
test('dump streaming reads supplied bytes once and yields with bounded read ahead and page memory', streaming);

async function reconcile(scenario: Scenario) {
  const fixed = new Map<number, string>();
  const samples = new Map<string, GrowthSample[]>();
  const pages = new Map<string, GrowthSample[]>();
  for (const axis of ['n', 'history', 'fields'] as const)
    for (const scale of scales) {
      const seed = { ...options(scenario), [axis]: scale };
      const fixture = await d().seed(seed);
      const signature = Buffer.from(fixture.converters[0].input).toString('base64');
      if (fixed.has(seed.fields)) expect(signature).toBe(fixed.get(seed.fields)!);
      fixed.set(seed.fields, signature);
      const items = scenario === 'bulk' ? seed.fields : scenario === 'vanished-page' ? B : 1;
      const result = await d().measure(() =>
        d().run({ kind: scenario, source: seed.source, key: seed.key, fields: seed.fields, pageCap: B }),
      );
      const cost = database(result.counters, fixture, seed, items);
      for (const engine of ['sqlite', 'postgres'] as const) {
        const key = `${axis}:${engine}`;
        const group = samples.get(key) ?? [];
        group.push({ scale, cost: cost[engine] });
        samples.set(key, group);
      }
      const sql = result.counters.statements.map((s) => `${s.sql}\n${s.explain}`).join('\n');
      if (scenario === 'mass-disappearance') {
        expect(result.value.status).toBe('mass-disappearance-blocked');
        expect(result.value.publicWrites).toBe(0);
        expect(sql).toMatch(/baseline/i);
        expect(sql).toMatch(/seen|survivor/i);
      } else {
        expect(result.value.status).toBe('completed');
        expect(result.value.publicWrites).toBe(scenario === 'unchanged' ? 0 : items);
        if (scenario !== 'vanished-page') {
          expect(sql).toMatch(/source/i);
          expect(sql).toMatch(/record_key/i);
          expect(result.value.fenceChecks).toBeGreaterThanOrEqual(items);
          expect(sql).toMatch(/external_id/i);
          expect(sql).toMatch(/field_group/i);
          if (scenario !== 'unchanged') expect(result.value.serverFenceChecks).toBeGreaterThanOrEqual(items);
        }
      }
      if (scenario === 'vanished-page') {
        expect(result.value.visitedKeys).toEqual(fixture.vanishedKeys.slice(0, B));
        expect(result.value.visitedKeys.length).toBe(B);
        expect(new Set(result.value.visitedKeys).size).toBe(B);
        expect(result.value.nextCursor).toBeTruthy();
        expect(sql).toMatch(/run_id|generation/i);
        expect(sql).toMatch(/record_key\s*>/i);
        expect(sql).toMatch(/limit/i);
        const next = await d().measure(() =>
          d().run({
            kind: scenario,
            source: seed.source,
            key: seed.key,
            fields: seed.fields,
            pageCap: B,
            cursor: result.value.nextCursor!,
          }),
        );
        const nextCost = database(next.counters, fixture, seed, B);
        for (const engine of ['sqlite', 'postgres'] as const) {
          const key = `${axis}:${engine}`;
          const group = pages.get(key) ?? [];
          group.push({ scale, cost: nextCost[engine] });
          pages.set(key, group);
        }
        expect(next.value.visitedKeys).toEqual(fixture.vanishedKeys.slice(B, B * 2));
        expect(next.value.visitedKeys.length).toBeGreaterThan(0);
        expect(next.value.visitedKeys.length).toBeLessThanOrEqual(B);
        for (const key of next.value.visitedKeys) expect(result.value.visitedKeys).not.toContain(key);
      }
    }
  for (const [key, group] of [...samples, ...pages]) {
    const payload = key.startsWith('fields:');
    assertGrowth(group, {
      rows: payload ? 'linear' : 'constant',
      blocks: key.endsWith(':sqlite') ? 'constant' : payload ? 'linear' : 'logarithmic',
      statements: payload ? 'linear' : 'constant',
    });
  }
}
test('unchanged refresh still point seeks the fence without reading source or subject history', async () => {
  await reconcile('unchanged');
});
test('one new record uses an indexed missing key seek and bounded authoritative writes', async () => {
  await reconcile('new');
});
test('one changed record uses per key reconciliation and bounded authoritative writes', async () => {
  await reconcile('changed');
});
test('converter revision change has the same bounded indexed reconciliation cost', async () => {
  await reconcile('revision');
});
test('mass disappearance is detected from maintained counters before publishing', async () => {
  await reconcile('mass-disappearance');
});
test('allowed vanished records use bounded source generation keyset pages', async () => {
  await reconcile('vanished-page');
});
test('bulk client requests grow only with the separately bounded command batch', async () => {
  await reconcile('bulk');
});
test('bulk client rejects a batch beyond the hard command cap before publishing', async () => {
  const seed = options('bulk', 32, 32, 512);
  const fixture = await d().seed(seed);
  const result = await d().measure(() =>
    d().run({ kind: 'bulk', source: seed.source, key: seed.key, fields: 513, pageCap: B }),
  );
  expect(result.value.status).toBe('batch-too-large');
  expect(result.value.publicWrites).toBe(0);
  // Local rejection may touch nothing; server rejection may perform bounded
  // authentication. Neither can submit the oversized command batch.
  common(result.counters);
  expect(result.counters.networkRequests).toBeLessThanOrEqual(1);
  if (result.counters.statements.length) database(result.counters, fixture, seed);
  else expect(result.counters.partitions).toEqual([]);
});
