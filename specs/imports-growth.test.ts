import { afterEach, beforeEach, expect, test } from 'bun:test';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Counters, Fixture, ImportGrowthDriver, Scenario, Seed } from './imports-growth-driver';

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
function database(c: Counters, fixture: Fixture, seed: Seed, items = 1) {
  common(c);
  expect(c.statements.length).toBeGreaterThan(0);
  expect(c.statements.length).toBeLessThanOrEqual(24 * items);
  expect(fixture.partitions.length).toBeLessThanOrEqual(4 * items);
  expect(new Set(c.partitions).size).toBeLessThanOrEqual(4 * items);
  for (const partition of c.partitions) expect(fixture.partitions).toContain(partition);
  const height = Math.ceil(Math.log2(seed.n + seed.history + 2));
  let rows = 0;
  for (const statement of c.statements) {
    for (const value of [statement.rowsExamined, statement.rowsAppended, statement.indexBuffers]) integer(value);
    rows += statement.rowsExamined + statement.rowsAppended;
    expect(statement.indexBuffers).toBeLessThanOrEqual(8 * (24 * items * height + seed.fields));
    expect(statement.sql.length).toBeGreaterThan(0);
    expect(statement.explain.length).toBeGreaterThan(0);
    expect(statement.sql).not.toMatch(/\bcount\s*\(/i);
    // Inspect actual engine access paths, including nested plans. Reject full
    // index scans as well as table scans; fixture size never excuses a scan.
    expect(statement.explain).not.toMatch(/Seq Scan|Bitmap Heap Scan|USE TEMP B-TREE/i);
    if (statement.engine === 'sqlite') {
      expect(statement.explain).not.toMatch(/\bSCAN\b/i);
      integer(statement.sqliteFullscanSteps!);
      integer(statement.sqliteVmSteps!);
      expect(statement.sqliteFullscanSteps).toBe(0);
      expect(statement.sqliteVmSteps!).toBeLessThanOrEqual(128 * (24 * items * height + seed.fields));
      if (/\b(select|update|delete)\b/i.test(statement.sql)) {
        expect(statement.explain).toMatch(/SEARCH .*USING (?:COVERING )?(?:INDEX|PRIMARY KEY)/i);
      }
    } else {
      expect(statement.engine).toBe('postgres');
      const walk = (node: Record<string, unknown>) => {
        const type = String(node['Node Type'] ?? '');
        if (/Scan/.test(type)) {
          expect(type).toMatch(/^Index(?: Only)? Scan$/);
          expect(String(node['Index Cond'] ?? '')).not.toBe('');
        }
        for (const child of (node.Plans ?? []) as Record<string, unknown>[]) walk(child);
      };
      const plan = JSON.parse(statement.explain);
      expect(plan[0].Plan).toBeDefined();
      walk(plan[0].Plan);
      expect(statement.explain).toContain('Actual Rows');
      expect(statement.explain).toContain('Shared Hit Blocks');
    }
  }
  expect(rows).toBeLessThanOrEqual(64 * (items + seed.fields));
  const buffers = c.statements.reduce((sum, s) => sum + s.indexBuffers, 0);
  const vm = c.statements.reduce((sum, s) => sum + (s.sqliteVmSteps ?? 0), 0);
  expect(buffers).toBeLessThanOrEqual(8 * (24 * items * height + seed.fields));
  expect(vm).toBeLessThanOrEqual(128 * (24 * items * height + seed.fields));
  expect(c.networkRequests).toBeLessThanOrEqual(8 * items);
  expect(c.allocatedBytes).toBeLessThanOrEqual(64 * (items * RECORD_CAP + seed.fields * 1024));
  expect(c.peakRetainedBytes).toBeLessThanOrEqual(4 * (B * RECORD_CAP + seed.fields * 1024));
  expect(c.peakRetainedRecords).toBeLessThanOrEqual(seed.scenario === 'bulk' ? items : B);
  return {
    rows,
    statements: c.statements.length,
    height,
    buffers,
    vm,
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
  const baseline = new Map<string, ReturnType<typeof database>>();
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
      if (axis !== 'fields') {
        const first = baseline.get(axis);
        if (first) {
          expect(cost.rows).toBeLessThanOrEqual(first.rows);
          expect(cost.statements).toBeLessThanOrEqual(first.statements);
          const levels = cost.height - first.height;
          expect(cost.buffers).toBeLessThanOrEqual(first.buffers + 8 * first.statements * levels);
          expect(cost.vm).toBeLessThanOrEqual(first.vm + 128 * first.statements * levels);
        } else baseline.set(axis, cost);
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
        database(next.counters, fixture, seed, B);
        expect(next.value.visitedKeys).toEqual(fixture.vanishedKeys.slice(B, B * 2));
        expect(next.value.visitedKeys.length).toBeGreaterThan(0);
        expect(next.value.visitedKeys.length).toBeLessThanOrEqual(B);
        for (const key of next.value.visitedKeys) expect(result.value.visitedKeys).not.toContain(key);
      }
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
