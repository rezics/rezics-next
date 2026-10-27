import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { BATCH_LIMIT, checkBatchWrite } from '../packages/definitions/src/bulk';
import { convertBangumi } from '../packages/conversion/src/bangumi';
import { convertVndb, vndbLimits } from '../packages/conversion/src/vndb';
import { convertWikidata, wikidataLimits } from '../packages/conversion/src/wikidata';
import { convertOpenLibrary } from '../packages/conversion/src/open-library';
import type { ConversionInput } from '../packages/conversion/src';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertGrowth, type GrowthSample } from '../services/kernel/test/support/growth-bound';
import { costOf, isControlStatement } from '../services/kernel/test/support/growth-cost';
import type { Counters, Fixture, ImportGrowthDriver, Scenario, Seed, SqliteStatement } from './imports-growth-driver';
import { assertIndexedSqlite } from './support/verify-import-api';

const scales = Object.freeze([32, 128, 512] as const);
const payloadScales = Object.freeze([1, 8, 64] as const);
const axisScales = (axis: string) => (axis === 'fields' ? payloadScales : scales);
// Private constants are read from released code, not duplicated as universal caps.
const sourceCode = (name: string) =>
  readFileSync(new URL(`../packages/conversion/src/${name}.ts`, import.meta.url), 'utf8');
const bangumiCode = sourceCode('bangumi');
const openLibraryCode = sourceCode('open-library');
function codeNumber(code: string, pattern: RegExp): number {
  const match = pattern.exec(code);
  if (!match) throw new Error(`Released source cap not found: ${pattern}`);
  return Number(match[1]!.replaceAll('_', ''));
}
const sourceContracts = [
  {
    name: 'bangumi',
    convert: convertBangumi,
    fields: codeNumber(bangumiCode, /length > (\d+)\)/),
    bytes: codeNumber(bangumiCode, /JSON.stringify\(record\), 'utf8'\) > ([\d_]+)/),
    collection: 'tags',
  },
  {
    name: 'vndb',
    convert: convertVndb,
    fields: vndbLimits.maxTitles,
    bytes: vndbLimits.recordBytes,
    collection: 'vn_titles',
  },
  {
    name: 'wikidata',
    convert: convertWikidata,
    fields: wikidataLimits.terms,
    bytes: wikidataLimits.bytes,
    collection: 'labels',
  },
  {
    name: 'open-library',
    convert: convertOpenLibrary,
    fields: codeNumber(openLibraryCode, /const fieldCap = (\d+)/),
    bytes: codeNumber(openLibraryCode, /const recordBytes = (\d+) \* 1024 \* 1024/) * 1024 * 1024,
    collection: 'publishers',
  },
] as const;
const B = 8;
const RECORD_CAP = 65536;
let driver: ImportGrowthDriver | undefined;
let declaredBudgets: string | undefined;
beforeEach(async () => {
  const path = process.env.IMPORT_GROWTH_DRIVER;
  if (!path) throw new Error('IMPORT_GROWTH_DRIVER is required: bind real import path counters');
  if (!isAbsolute(path) && !path.startsWith('file:')) throw new Error('Expected absolute import growth driver path');
  const url = isAbsolute(path) ? pathToFileURL(path) : new URL(path);
  if (url.protocol !== 'file:') throw new Error('Expected local import growth driver');
  const binding = await import(url.href);
  driver = await binding.createImportGrowthDriver();
  const budgets = JSON.stringify(d().statementBudgets);
  if (declaredBudgets !== undefined) expect(budgets).toBe(declaredBudgets);
  declaredBudgets = budgets;
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
function common(c: Counters): asserts c is Required<Counters> {
  for (const value of [c.networkRequests, c.workUnits, c.allocatedBytes, c.peakRetainedBytes, c.peakRetainedRecords])
    integer(value!);
}
function purity(c: Counters) {
  integer(c.networkRequests);
  expect(c.partitions).toEqual([]);
  expect(c.statements).toEqual([]);
  expect(c.postgres.statements).toEqual([]);
  expect(c.postgres.plans).toEqual([]);
  expect(c.networkRequests).toBe(0);
}
function readerCost(c: Counters, bytes: number, fields: number, byteCap = RECORD_CAP) {
  common(c);
  purity(c);
  expect(c.workUnits).toBeGreaterThan(0);
  expect(c.workUnits).toBeLessThanOrEqual(64 * (bytes + fields));
  expect(c.allocatedBytes).toBeGreaterThan(0);
  expect(c.allocatedBytes).toBeLessThanOrEqual(64 * (bytes + fields));
  expect(c.peakRetainedBytes).toBeLessThanOrEqual(64 * (Math.min(bytes, byteCap) + fields));
}
// Test support only: raw plans and declared schema prove SQLite access bounds;
// returned rows alone cannot reveal a full scan that returns one aggregate row.
// Both import suites share one SQLite validator, in specs/support/verify-import-api.ts.
function sqliteKeyProof(statement: SqliteStatement, c: Counters) {
  if (statement.changes !== undefined) integer(statement.changes);
  for (const row of JSON.parse(statement.explain) as { id: number; parent: number }[]) {
    integer(row.id);
    integer(row.parent);
  }
  assertIndexedSqlite(statement, c.sqlite);
}
function database(c: Counters, fixture: Fixture, seed: Seed, items = 1) {
  common(c);
  expect(c.statements.length).toBeGreaterThan(0);

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
  // Measured plans are the planner's own choice on unpinned sessions. auto_explain also emits nested plans without a
  // separate client query call; their query texts join the index proof rather than silently dropping nested
  // authorization work.
  const roots = (document: unknown) =>
    (Array.isArray(document) ? document : [document]) as { Plan: Record<string, unknown>; 'Query Text'?: unknown }[];
  const texts = new Set(postgresStatements.filter((s) => s.explain).map((s) => s.sql));
  for (const document of c.postgres.plans) {
    for (const root of roots(document)) {
      expect(root.Plan).toBeDefined();
      if (typeof root['Query Text'] === 'string') texts.add(root['Query Text']);
    }
    expect(JSON.stringify(document)).toContain('Actual Rows');
    expect(JSON.stringify(document)).toContain('Shared Hit Blocks');
  }
  // Index service is proven apart from measurement: the generic plan of every captured text, with sequential scans
  // disabled, reaches every table through an index condition. A sequential scan left there, or an index scan without
  // a condition, means no index serves the predicate.
  expect(new Set(c.indexPlans.map((p) => p.sql))).toEqual(texts);
  for (const { plan } of c.indexPlans) {
    const walk = (node: Record<string, unknown>) => {
      // CTE, function and VALUES scans read only their own inputs, which are planned separately.
      const type = String(node['Node Type'] ?? '');
      if (typeof node['Relation Name'] === 'string')
        expect(type).toMatch(/^(?:Index(?: Only)? Scan|Bitmap Heap Scan|ModifyTable)$/);
      if (/^(?:Index(?: Only)?|Bitmap Index) Scan$/.test(type)) expect(String(node['Index Cond'] ?? '')).not.toBe('');
      for (const child of (node.Plans ?? []) as Record<string, unknown>[]) walk(child);
    };
    for (const root of roots(plan)) {
      expect(root.Plan).toBeDefined();
      walk(root.Plan);
    }
  }
  expect(JSON.stringify(d().statementBudgets)).toBe(declaredBudgets!);
  const terms = d().statementBudgets[seed.scenario];
  expect(terms.length).toBeGreaterThan(0);
  for (const engine of ['sqlite', 'postgres'] as const) {
    const methods = terms.filter((term) => term.engine === engine);
    expect(methods.length).toBeGreaterThan(0);
    let ceiling = 0;
    for (const term of methods) {
      expect(term.method.length).toBeGreaterThan(0);
      expect(term.derivation).toMatch(/(?:services|packages)\/.+/);
      for (const coefficient of [term.fixed, term.perItem, term.perField]) integer(coefficient);
      ceiling += term.fixed + term.perItem * items + term.perField * seed.fields;
    }
    // Nested PG plans are executions too; controls have no plans. Keep all raw
    // evidence and conservatively charge both client calls and nested plans.
    const executions = engine === 'sqlite' ? sqliteStatements : postgresStatements.length + c.postgres.plans.length;
    expect(executions).toBeLessThanOrEqual(ceiling);
  }
  // Per-call constants belong to Cost sections: the importer's for SQLite, and Auth, Access, semantic and content's
  // for PostgreSQL. The callers' growth checks prove rows, statements and requests stay bounded as the catalogue,
  // history and payload grow.
  const postgres = costOf(c.postgres); // actual examined rows, inclusive shared hits + reads
  const appended = postgresStatements.reduce((sum, s) => sum + s.rowsAppended, 0);
  integer(c.networkRequests);
  expect(c.allocatedBytes).toBeLessThanOrEqual(64 * (items * RECORD_CAP + seed.fields * 1024));
  expect(c.peakRetainedBytes).toBeLessThanOrEqual(4 * (B * RECORD_CAP + seed.fields * 1024));
  expect(c.peakRetainedRecords).toBeLessThanOrEqual(seed.scenario === 'bulk' ? items : B);
  return {
    // blocks:0 means unavailable SQLite buffers, not zero physical I/O.
    sqlite: { rows: returned, blocks: 0, statements: sqliteStatements },
    postgres: {
      ...postgres,
      rows: postgres.rows + appended,
      statements: postgresStatements.length + c.postgres.plans.length,
    },
    // Status polls may repeat, so requests are compared with row slack.
    network: { rows: c.networkRequests, blocks: 0, statements: 0 },
  };
}
const options = (scenario: Scenario, n = 32, history = 32, fields = 1): Seed =>
  Object.freeze({ n, history, fields, scenario, source: 'growth-source', key: 'fixed-record' });

async function converters(index: number, oversized?: 'bytes' | 'fields') {
  const inputs = new Map<number, string>();
  const samples: { input: number; output: number }[] = [];
  const returns = new Map<number, string>();
  // Vary N, U x t and M independently; never inflate the measured payload with N.
  for (const axis of ['n', 'history', 'fields'] as const)
    for (const scale of axisScales(axis)) {
      const seed = { ...options('changed'), [axis]: scale };
      const fixture = await d().seed(seed);
      expect(new Set(fixture.converters.map((c) => c.exportPath)).size).toBe(4);
      const converter = fixture.converters[index]!;
      const contract = sourceContracts[index]!;
      expect(converter.limits).toEqual({ bytes: contract.bytes, fields: contract.fields });
      expect(converter.exportPath).toMatch(new RegExp(`${contract.name}(?:\\.ts)?(?:#|:|/|$)`));
      expect(Math.min(...sourceContracts.map((source) => source.fields))).toBe(payloadScales[2]);
      const inputsToCheck =
        oversized === 'bytes'
          ? [converter.atByteCap, converter.oversized]
          : oversized === 'fields'
            ? [converter.atFieldCap, converter.tooManyFields]
            : [converter.input];
      for (const [boundary, input] of inputsToCheck.entries()) {
        const rejected = Boolean(oversized && boundary === 1);
        const raw = JSON.parse(Buffer.from(input).toString('utf8')) as ConversionInput<Record<string, unknown>>;
        const collection = raw.record[contract.collection] as object;
        const fields = Object.keys(collection).length;
        if (oversized === 'fields') {
          expect(fields).toBe(contract.fields + boundary);
          expect(Buffer.byteLength(JSON.stringify(raw.record))).toBeLessThanOrEqual(contract.bytes);
        } else if (!oversized) expect(fields).toBe(seed.fields);
        if (oversized === 'bytes')
          expect(Buffer.byteLength(JSON.stringify(raw.record))).toBe(contract.bytes + boundary);
        // Fixture validation is outside measurement. The measured run must invoke
        // the same real converter, including projection/validation, from scratch.
        if (!rejected) {
          const converted = contract.convert(raw);
          if (oversized) expect(converted.normalizedRecord as unknown).toEqual(raw.record);
        } else {
          const permitted = JSON.parse(Buffer.from(inputsToCheck[0]!).toString('utf8')) as ConversionInput<
            Record<string, unknown>
          >;
          if (oversized === 'fields') {
            const reduced = structuredClone(raw);
            const values = reduced.record[contract.collection] as Record<string, unknown>;
            if (Array.isArray(values)) values.pop();
            else delete values[Object.keys(values).at(-1)!];
            expect(reduced).toEqual(permitted);
          } else {
            // Exactly one ASCII byte added to the accepted supported projection.
            const before = JSON.stringify(permitted),
              after = JSON.stringify(raw);
            let offset = 0;
            while (before[offset] === after[offset]) offset++;
            expect(after.length).toBe(before.length + 1);
            expect(after.charCodeAt(offset)).toBeLessThan(128);
            expect(after.slice(0, offset) + after.slice(offset + 1)).toBe(before);
          }
          expect(() => contract.convert(raw)).toThrow(
            oversized === 'bytes'
              ? /invalid_record_byte_limit|Allowed dump projection exceeds 64 KiB|Source record exceeds 128 KiB|source_record_byte_limit_2_MiB/
              : /invalid_record_tag_limit|Dump row count exceeds source cap|Source term limit exceeded|source_field_limit_64/,
          );
        }
        const signature = `${converter.exportPath}:${Buffer.from(input).toString('base64')}`;
        const key = seed.fields * 2 + boundary;
        if (inputs.has(key)) expect(signature).toBe(inputs.get(key)!);
        inputs.set(key, signature);
        const result = await d().measure(() => d().run({ kind: 'convert', exportPath: converter.exportPath, input }));
        expect(result.value.status).toBe(rejected ? 'record-too-large' : 'completed');
        purity(result.counters);
        if (!rejected) {
          // Frozen pure-cost amendment: serialize the ENTIRE untouched actual return,
          // including normalizedRecord/hash input, never an output-only projection.
          const actual = JSON.stringify(result.value.actualReturn);
          expect(actual).toBe(JSON.stringify(contract.convert(raw)));
          if (!oversized) {
            if (returns.has(seed.fields)) expect(actual).toBe(returns.get(seed.fields)!);
            returns.set(seed.fields, actual);
            if (axis === 'fields')
              samples.push({ input: Buffer.byteLength(JSON.stringify(raw.record)), output: Buffer.byteLength(actual) });
          }
        }
      }
    }
  if (!oversized) {
    // Plain three-sample logical proof; no timing, heap or computed work model.
    expect(samples).toHaveLength(3);
    const [a, b, c] = samples as [(typeof samples)[number], (typeof samples)[number], (typeof samples)[number]];
    expect(b.input).toBeGreaterThan(a.input);
    expect(c.input).toBeGreaterThan(b.input);
    expect(b.output).toBeGreaterThanOrEqual(a.output);
    expect(c.output).toBeGreaterThanOrEqual(b.output);
    expect((c.output - b.output) * (b.input - a.input)).toBeLessThanOrEqual(
      (b.output - a.output) * (c.input - b.input),
    );
    const fixture = (await d().seed(options('changed'))).converters[index]!;
    const fixed = await d().measure(() =>
      d().run({ kind: 'convert', exportPath: fixture.exportPath, input: fixture.input }),
    );
    purity(fixed.counters);
    expect(fixed.value.status).toBe('completed');
    const expected = JSON.stringify(fixed.value.actualReturn);
    expect(expected).toBe(returns.get(1)!);
    const fixedInput = JSON.parse(Buffer.from(fixture.input).toString('utf8')) as ConversionInput;
    let converted = 0;
    const ids = new Set<string>();
    for (const count of [32, 8 * 32, 64 * 32]) {
      const measured = await d().measure(async () => {
        while (converted < count) {
          const input = fixture.unrelatedInput(converted++);
          const native = JSON.parse(Buffer.from(input).toString('utf8')) as ConversionInput<Record<string, unknown>>;
          expect(native.external_id).not.toBe(fixedInput.external_id);
          expect(ids.has(native.external_id)).toBe(false);
          ids.add(native.external_id);
          const result = await d().run({ kind: 'convert', exportPath: fixture.exportPath, input });
          expect(result.status).toBe('completed');
          expect(JSON.stringify(result.actualReturn)).toBe(JSON.stringify(sourceContracts[index]!.convert(native)));
        }
        return d().run({ kind: 'convert', exportPath: fixture.exportPath, input: fixture.input });
      });
      purity(measured.counters);
      expect(measured.value.status).toBe('completed');
      expect(JSON.stringify(measured.value.actualReturn)).toBe(expected);
    }
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
      common(result.counters);
      readerCost(result.counters, supplied * record.byteLength, supplied);
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
    for (const scale of axisScales(axis)) {
      const seed = { ...options(scenario), [axis]: scale };
      const fixture = await d().seed(seed);
      const signature = Buffer.from(fixture.converters[0].input).toString('base64');
      if (fixed.has(seed.fields)) expect(signature).toBe(fixed.get(seed.fields)!);
      fixed.set(seed.fields, signature);
      const items = scenario === 'bulk' ? seed.fields : scenario === 'vanished-page' ? B : 1;
      const result = await d().measure(() =>
        d().run({ kind: scenario, source: seed.source, key: seed.key, fields: seed.fields, pageCap: B }),
      );
      if (scenario === 'bulk') {
        publicEnvelopes(result.value.envelopes, 2 * seed.fields);
        const commands = result.value.envelopes!.flatMap((body) => JSON.parse(body).commands);
        expect(commands.filter((command) => command.op === 'retract').length).toBe(seed.fields);
        expect(commands.filter((command) => command.op === 'propose').length).toBe(seed.fields);
        expect(result.counters.networkRequests).toBeGreaterThanOrEqual(result.value.envelopes!.length);
      }
      const cost = database(result.counters, fixture, seed, items);
      for (const engine of ['sqlite', 'postgres', 'network'] as const) {
        const key = `${axis}:${engine}`;
        const group = samples.get(key) ?? [];
        group.push({ scale, cost: cost[engine] });
        samples.set(key, group);
      }
      const sql = result.counters.statements.map((s) => `${s.sql}\n${s.explain}`).join('\n');
      if (scenario === 'mass-disappearance') {
        expect(result.value.status).toBe('mass-disappearance-blocked');
        expect(result.value.publicWrites).toBe(0);
      } else {
        expect(result.value.status).toBe('completed');
        expect(result.value.publicWrites).toBe(scenario === 'unchanged' ? 0 : items);
        if (scenario !== 'vanished-page') {
          expect(sql).toMatch(/source/i);
          expect(sql).toMatch(/record_key|external_id/i);
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
        expect(sql).toMatch(/record_key\s*\)?\s*>/i);
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
        for (const engine of ['sqlite', 'postgres', 'network'] as const) {
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
      blocks: key.endsWith(':postgres') ? (payload ? 'linear' : 'logarithmic') : 'constant',
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
  const seed = options('bulk', 32, 32, 64);
  const fixture = await d().seed(seed);
  const result = await d().measure(() => d().run({ kind: 'public-bulk', commands: 101 }));
  expect(result.value.status).toBe('batch-too-large');
  expect(result.value.publicWrites).toBe(0);
  // Local rejection may touch nothing; server rejection may perform bounded
  // authentication. Neither can submit the oversized command batch.
  common(result.counters);
  expect(result.counters.networkRequests).toBeLessThanOrEqual(1);
  if (result.counters.statements.length) database(result.counters, fixture, seed);
  else expect(result.counters.partitions).toEqual([]);
});

// Validate actual wire bodies, not reported counts or private oversized shapes.
function publicEnvelopes(envelopes: readonly string[] | undefined, commands: number) {
  expect(envelopes).toBeDefined();
  let count = 0;
  const keys = new Set<string>();
  for (const [index, body] of envelopes!.entries()) {
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(RECORD_CAP);
    const request = JSON.parse(body);
    expect(checkBatchWrite(request)).toEqual([]);
    expect(request.commands.length).toBeLessThanOrEqual(BATCH_LIMIT);
    const next = envelopes![index + 1];
    if (next) {
      const combined = { commands: [...request.commands, JSON.parse(next).commands[0]] };
      expect(combined.commands.length > BATCH_LIMIT || Buffer.byteLength(JSON.stringify(combined)) > RECORD_CAP).toBe(
        true,
      );
    }
    count += request.commands.length;
    for (const command of request.commands) {
      expect(keys.has(command.key)).toBe(false);
      keys.add(command.key);
    }
  }
  expect(count).toBe(commands);
  expect(envelopes!.length).toBeGreaterThanOrEqual(Math.ceil(commands / BATCH_LIMIT));
}
test('private 300 command plans split by both public command and byte caps', async () => {
  const seed = options('bulk', 32, 32, 64);
  const fixture = await d().seed(seed);
  const result = await d().measure(() => d().run({ kind: 'private-plan', commands: 300, byteHeavy: true }));
  expect(result.value.status).toBe('completed');
  publicEnvelopes(result.value.envelopes, 300);
  // Valid commands sized so the byte cap forces splitting before command 100.
  expect(result.value.envelopes!.length).toBeGreaterThan(3);
  database(result.counters, fixture, seed, 300);
});
test('configured platform reader cap accepts exactly 64 KiB and rejects the next content byte independently of source caps', async () => {
  const fixture = await d().seed(options('unchanged'));
  for (const [index, record] of [fixture.dumpAtCap, fixture.dumpOverCap].entries()) {
    // A framed NDJSON record has one trailing newline, excluded from the cap.
    expect(record.at(-1)).toBe(10);
    expect(record.byteLength).toBe(RECORD_CAP + index + 1);
    JSON.parse(Buffer.from(record).toString('utf8'));
    const input = {
      async *[Symbol.asyncIterator]() {
        yield record;
      },
    };
    const result = await d().measure(async () => {
      let yielded = 0;
      try {
        for await (const _ of d().stream(input, { pageCap: B, recordByteCap: RECORD_CAP })) yielded++;
      } catch (error) {
        if (index === 0) throw error;
        expect(String(error)).toMatch(/Dump (?:record|line) exceeds byte limit/);
        expect(yielded).toBe(0);
        return 'record-too-large';
      }
      expect(yielded).toBe(1);
      return 'completed';
    });
    expect(result.value).toBe(index === 0 ? 'completed' : 'record-too-large');
    readerCost(result.counters, record.byteLength, 1);
  }
});
