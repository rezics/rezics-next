import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { BatchCommand, BatchWriteRequest } from '@rezics/definitions/bulk';
import { ConversionError, type ConversionInput } from '../../../../packages/conversion/src/index.ts';
import { convertBangumi } from '../../../../packages/conversion/src/bangumi.ts';
import { convertVndb, vndbLimits } from '../../../../packages/conversion/src/vndb.ts';
import { convertWikidata, wikidataLimits } from '../../../../packages/conversion/src/wikidata.ts';
import { convertOpenLibrary } from '../../../../packages/conversion/src/open-library.ts';
import { createSourceRegistration } from '../../../importer/src/source-registry.ts';
import { readDump } from '../../../importer/src/dumps.ts';
import { createDumpCounters, observeDumpRetention, type DumpCounters } from '../../../importer/src/dumps-bytes.ts';
import type { SourceRecord } from '../../../../packages/conversion/src/index.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { openApiRuntime } from './api-runtime.ts';
import { createApiPopulation } from './api-population.ts';
import { createGrowthSqliteCapture } from './growth-sqlite-capture.ts';
import type {
  Counters,
  Fixture,
  ImportGrowthDriver,
  Operation,
  Outcome,
  PostgresStatement,
  Scenario,
  Seed,
  StatementBudgetTerm,
} from '../../../../specs/imports-growth-driver.ts';
import type { Capture } from '../support/growth.ts';

type RecordValue = Record<string, unknown>;
type GrowthState = {
  seed: Readonly<Seed>;
  fixture: Fixture;
  privateSource: string;
  run?: { source: string; id: string; lease: string };
  vanished: string[];
  pageWrites: Map<string, { subject: string; candidate?: string }>;
};
type MeasuredMemory = { allocated: number; peakBytes: number; peakRecords: number };
type WarmScenarioOperation = {
  kind: Scenario;
  source: string;
  key: 'fixed-record';
  fields: number;
  pageCap: 8;
  cursor?: string;
};
const reportedCaptureDiagnostics = new Set<string>();
const B = 8;

const utf8 = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const bytes = (value: string) => new TextEncoder().encode(value);
const itemName = (seed: Readonly<Seed>, prefix: string) => `${prefix} ${seed.fields}`;
const external = (record: RecordValue) => String(record.id);
const vndbLanguages = [
  'aa',
  'ab',
  'ae',
  'af',
  'ak',
  'am',
  'ar',
  'as',
  'az',
  'ba',
  'be',
  'bg',
  'bh',
  'bi',
  'bm',
  'bn',
  'bo',
  'br',
  'bs',
  'ca',
  'ce',
  'ch',
  'co',
  'cr',
  'cs',
  'cu',
  'cv',
  'cy',
  'da',
  'de',
  'dv',
  'dz',
  'ee',
  'el',
  'en',
  'eo',
  'es',
  'et',
  'eu',
  'fa',
  'ff',
  'fi',
  'fj',
  'fo',
  'fr',
  'fy',
  'ga',
  'gd',
  'gl',
  'gn',
  'gu',
  'gv',
  'ha',
  'he',
  'hi',
  'ho',
  'hr',
  'ht',
  'hu',
  'hy',
  'ia',
  'id',
  'ie',
  'ig',
  'ii',
  'ik',
  'io',
  'is',
  'it',
];
const bindingKey = (owner: { source: string; external_id: string }, identity: string) =>
  `${owner.source}:${owner.external_id}:growth:${hash(identity)}`;

function languages(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `en-${String(index + 1).padStart(3, '0')}`);
}

function exactJsonText<T extends RecordValue>(record: T, target: number, edit: (amount: number) => void): T {
  const current = Buffer.byteLength(JSON.stringify(record));
  edit(target - current);
  if (Buffer.byteLength(JSON.stringify(record)) !== target) throw new Error('Could not construct exact source cap');
  return record;
}

function bangumiRecord(fields: number, name = 'Growth fixed'): RecordValue {
  return {
    id: 1,
    type: 1,
    name,
    tags: Array.from({ length: fields }, (_, index) => ({ name: `tag-${index + 1}` })),
  };
}

function bangumiInput(record: RecordValue, id = String(record.id)): Uint8Array {
  return utf8({ external_id: id, record_revision: null, record });
}

function vndbRecord(fields: number, id: string, revision: number, titleSize = 12): RecordValue {
  return {
    vn: { id, olang: 'en' },
    entry_meta: { id, revision },
    vn_titles: Array.from({ length: fields }, (_, index) => ({
      id,
      lang: vndbLanguages[index] ?? 'en',
      official: index === 0,
      title: `T${String(index + 1).padStart(2, '0')}${'x'.repeat(Math.max(0, titleSize - 3))}`,
      latin: null,
    })),
    vn_extlinks: [],
    extlinks: [],
  };
}

function tuneVndbRecord(target: number, fields: number): RecordValue {
  const record = vndbRecord(fields, 'v1', 1, 1);
  const extlinks = Array.from({ length: vndbLimits.maxLinks }, (_, index) => ({
    id: index + 1,
    site: 'unsupported-site',
    value: 'x',
  }));
  record.extlinks = extlinks;
  record.vn_extlinks = extlinks.map(({ id }) => ({ id: 'v1', link: id }));
  const baseline = Buffer.byteLength(JSON.stringify(record));
  let extra = target - baseline;
  for (const link of extlinks) {
    const amount = Math.min(extra, vndbLimits.stringBytes - String(link.value).length);
    if (amount > 0) link.value = `${link.value}${'x'.repeat(amount)}`;
    extra -= amount;
  }
  const titles = record.vn_titles as RecordValue[];
  let left = extra;
  for (const title of titles) {
    const amount = Math.min(left, 1500 - String(title.title).length);
    if (amount > 0) title.title = `${title.title}${'x'.repeat(amount)}`;
    left -= amount;
  }
  if (left !== 0 || Buffer.byteLength(JSON.stringify(record)) !== target)
    throw new Error('VNDB byte cap is not reachable with bounded titles');
  return record;
}

function wikidataRecord(fields: number, id: string, revision: number, valueSize = 12): RecordValue {
  const labels: Record<string, { language: string; value: string }> = {};
  languages(fields).forEach((language, index) => {
    labels[language] = {
      language,
      value: `L${String(index + 1).padStart(2, '0')}${'x'.repeat(Math.max(0, valueSize - 3))}`,
    };
  });
  return { id, type: 'item', lastrevid: revision, labels, aliases: {}, descriptions: {}, claims: {} };
}

function tuneWikidataRecord(target: number): RecordValue {
  const record = wikidataRecord(64, 'Q1', 1, 1);
  let left = target - Buffer.byteLength(JSON.stringify(record));
  const labels = record.labels as Record<string, { language: string; value: string }>;
  for (const label of Object.values(labels)) {
    const amount = Math.min(Math.floor(left / 2), 1499 - label.value.length);
    if (amount > 0) label.value += '\n'.repeat(amount);
    left -= amount * 2;
  }
  if (left === 1) {
    const last = Object.values(labels).at(-1)!;
    last.value += 'x';
    left--;
  }
  if (left !== 0 || Buffer.byteLength(JSON.stringify(record)) !== target)
    throw new Error('Wikidata byte cap is not reachable with supported terms');
  return record;
}

function openLibraryRecord(fields: number, key = '/works/OL1W', revision = 1, description?: string): RecordValue {
  return {
    type: { key: '/type/work' },
    key,
    revision,
    last_modified: { value: '2020-01-02T03:04:05Z' },
    title: 'Growth title',
    publishers: Array.from({ length: fields }, (_, index) => `Publisher ${index + 1}`),
    ...(description === undefined ? {} : { description }),
  };
}

function tuneOpenLibraryRecord(target: number): RecordValue {
  const record = openLibraryRecord(64, '/works/OL1W', 1, 'x');
  const base = Buffer.byteLength(JSON.stringify(record));
  const extra = target - base;
  const newlineCount = Math.floor(extra / 2);
  if (extra < 0 || newlineCount + 1 + (extra % 2) > 1024 * 1024)
    throw new Error('Open Library cap fixture exceeds prose cap');
  record.description = `x${'\n'.repeat(newlineCount)}${'x'.repeat(extra % 2)}`;
  if (Buffer.byteLength(JSON.stringify(record)) !== target)
    throw new Error('Open Library byte fixture length mismatch');
  return record;
}

function converterFixtures(fields: number) {
  const bangumiAt = bangumiRecord(0, 'x') as RecordValue;
  bangumiAt.infobox = '';
  const bangumiBytes = exactJsonText(bangumiAt, 65536, (amount) => {
    bangumiAt.infobox = 'x'.repeat(amount);
  });
  const bangumiOver = structuredClone(bangumiBytes) as RecordValue;
  bangumiOver.infobox = `${bangumiOver.infobox}x`;
  const bangumiBase = bangumiRecord(fields);
  const vndbFixed = vndbRecord(fields, 'v1', 1);
  const vndbAt = tuneVndbRecord(vndbLimits.recordBytes, 64);
  const vndbOver = structuredClone(vndbAt) as RecordValue;
  (vndbOver.vn_titles as RecordValue[])[0]!.title += 'x';
  const wikidataBase = wikidataRecord(fields, 'Q1', 1);
  const wikidataAt = tuneWikidataRecord(wikidataLimits.bytes);
  const wikidataOver = structuredClone(wikidataAt) as RecordValue;
  Object.values(wikidataOver.labels as Record<string, { value: string }>).at(-1)!.value += 'x';
  const openLibraryBase = openLibraryRecord(fields);
  const openLibraryAt = tuneOpenLibraryRecord(2 * 1024 * 1024);
  const openLibraryOver = structuredClone(openLibraryAt) as RecordValue;
  (openLibraryOver.publishers as string[])[0] += 'x';
  return [
    {
      limits: { bytes: 65536, fields: 64 },
      exportPath: `${resolve(import.meta.dir, '../../../../packages/conversion/src/bangumi.ts')}#convertBangumi`,
      input: bangumiInput(bangumiBase),
      unrelatedInput: (ordinal: number) => {
        const id = ordinal + 1000;
        return bangumiInput({ ...bangumiRecord(fields, `Catalogue ${id}`), id }, String(id));
      },
      atByteCap: bangumiInput(bangumiBytes),
      oversized: bangumiInput(bangumiOver),
      atFieldCap: bangumiInput(bangumiRecord(64)),
      tooManyFields: bangumiInput(bangumiRecord(65)),
    },
    {
      limits: { bytes: vndbLimits.recordBytes, fields: vndbLimits.maxTitles },
      exportPath: `${resolve(import.meta.dir, '../../../../packages/conversion/src/vndb.ts')}#convertVndb`,
      input: utf8({ external_id: 'v1', record_revision: '1', record: vndbFixed }),
      unrelatedInput: (ordinal: number) => {
        const id = `v${ordinal + 1000}`;
        return utf8({ external_id: id, record_revision: '1', record: vndbRecord(fields, id, 1) });
      },
      atByteCap: utf8({ external_id: 'v1', record_revision: '1', record: vndbAt }),
      oversized: utf8({ external_id: 'v1', record_revision: '1', record: vndbOver }),
      atFieldCap: utf8({ external_id: 'v1', record_revision: '1', record: vndbRecord(64, 'v1', 1) }),
      tooManyFields: utf8({ external_id: 'v1', record_revision: '1', record: vndbRecord(65, 'v1', 1) }),
    },
    {
      limits: { bytes: wikidataLimits.bytes, fields: wikidataLimits.terms },
      exportPath: `${resolve(import.meta.dir, '../../../../packages/conversion/src/wikidata.ts')}#convertWikidata`,
      input: utf8({ external_id: 'Q1', record_revision: '1', record: wikidataBase }),
      unrelatedInput: (ordinal: number) => {
        const id = `Q${ordinal + 1000}`;
        return utf8({
          external_id: id,
          record_revision: String(ordinal + 1000),
          record: wikidataRecord(fields, id, ordinal + 1000),
        });
      },
      atByteCap: utf8({ external_id: 'Q1', record_revision: '1', record: wikidataAt }),
      oversized: utf8({ external_id: 'Q1', record_revision: '1', record: wikidataOver }),
      atFieldCap: utf8({ external_id: 'Q1', record_revision: '1', record: wikidataRecord(64, 'Q1', 1) }),
      tooManyFields: utf8({ external_id: 'Q1', record_revision: '1', record: wikidataRecord(65, 'Q1', 1) }),
    },
    {
      limits: { bytes: 2 * 1024 * 1024, fields: 64 },
      exportPath: `${resolve(import.meta.dir, '../../../../packages/conversion/src/open-library.ts')}#convertOpenLibrary`,
      input: utf8({ external_id: '/works/OL1W', record_revision: '1', record: openLibraryBase }),
      unrelatedInput: (ordinal: number) => {
        const record = openLibraryRecord(fields, `/works/OL${ordinal + 1000}W`, ordinal + 1000);
        return utf8({ external_id: record.key, record_revision: String(record.revision), record });
      },
      atByteCap: utf8({ external_id: '/works/OL1W', record_revision: '1', record: openLibraryAt }),
      oversized: utf8({ external_id: '/works/OL1W', record_revision: '1', record: openLibraryOver }),
      atFieldCap: utf8({ external_id: '/works/OL1W', record_revision: '1', record: openLibraryRecord(64) }),
      tooManyFields: utf8({ external_id: '/works/OL1W', record_revision: '1', record: openLibraryRecord(65) }),
    },
  ] as Fixture['converters'];
}

function framedDump(target: number): Uint8Array {
  const record: RecordValue = { id: 1, type: 1, name: 'x', infobox: '' };
  record.infobox = 'x'.repeat(target - Buffer.byteLength(JSON.stringify(record)));
  const text = JSON.stringify(record);
  if (Buffer.byteLength(text) !== target) throw new Error('Dump frame size mismatch');
  return bytes(`${text}\n`);
}

function emptyCapture(): Capture {
  return { statements: [], plans: [] };
}

function planQuery(document: unknown): string | undefined {
  const roots = Array.isArray(document) ? document : [document];
  return roots.find(
    (value) => value && typeof value === 'object' && !Array.isArray(value) && typeof value['Query Text'] === 'string',
  )?.['Query Text'] as string | undefined;
}

function normalizedPlanSql(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').trim();
}

function rowsAppended(document: unknown): number {
  const roots = Array.isArray(document) ? document : [document];
  let rows = 0;
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const value = node as Record<string, unknown>;
    if (value['Node Type'] === 'ModifyTable' && typeof value['Actual Rows'] === 'number')
      rows += value['Actual Rows'] * (typeof value['Actual Loops'] === 'number' ? value['Actual Loops'] : 1);
    for (const child of (value.Plans ?? []) as unknown[]) visit(child);
  };
  for (const root of roots) {
    if (!root || typeof root !== 'object') continue;
    visit((root as Record<string, unknown>).Plan);
  }
  return rows;
}

function partitions(capture: Capture): string[] {
  const result = new Set<string>();
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
    } else if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        if (['Index Cond', 'Filter', 'Recheck Cond'].includes(key) && typeof child === 'string') {
          for (const match of child.matchAll(/\b(partition_no|route)\s*=\s*'?([0-9]+)'?/g)) {
            const value = Number(match[2]);
            result.add(String(match[1] === 'route' ? partitionOf(value) : value));
          }
        } else visit(child);
      }
    }
  };
  for (const plan of capture.plans) visit(plan);
  return [...result];
}

function postgresStatements(capture: Capture): PostgresStatement[] {
  const plans = new Map<string, unknown[]>();
  for (const [index, document] of capture.plans.entries()) {
    const sql = planQuery(document);
    if (sql === undefined) continue;
    const backend = capture.planBackends?.[index];
    const key = `${backend ?? '<unknown>'}\0${normalizedPlanSql(sql)}`;
    const documents = plans.get(key) ?? [];
    documents.push(document);
    plans.set(key, documents);
  }
  const offsets = new Map<string, number>();
  const statements: PostgresStatement[] = capture.statements.map((sql, index): PostgresStatement => {
    const backend = capture.statementBackends?.[index];
    const key = `${backend ?? '<unknown>'}\0${normalizedPlanSql(sql)}`;
    const documents = plans.get(key) ?? [];
    const offset = offsets.get(key) ?? 0;
    const explain = documents[offset];
    offsets.set(key, offset + (explain === undefined ? 0 : 1));
    if (
      explain === undefined &&
      !/^(?:BEGIN|START\s+TRANSACTION|COMMIT|END|ABORT|ROLLBACK|SAVEPOINT|RELEASE|SET\s+LOCAL|SET\s+TRANSACTION)\b/i.test(
        sql,
      )
    ) {
      const diagnostic = `unplanned SQL: ${sql}`;
      if (!reportedCaptureDiagnostics.has(diagnostic)) {
        reportedCaptureDiagnostics.add(diagnostic);
        console.error(`GROWTH_CAPTURE_DIAGNOSTIC ${diagnostic}`);
      }
    }
    return {
      engine: 'postgres',
      sql,
      explain: explain === undefined ? '' : JSON.stringify(explain),
      rowsAppended: explain === undefined ? 0 : rowsAppended(explain),
    };
  });
  // Repeated SQL texts can also produce nested plans. Charge each such raw plan once,
  // to the last execution of that same SQL, while keeping every plan in the raw capture.
  for (const [key, documents] of plans) {
    const indexes = capture.statements.flatMap((statement, index) => {
      const backend = capture.statementBackends?.[index];
      return `${backend ?? '<unknown>'}\0${normalizedPlanSql(statement)}` === key ? [index] : [];
    });
    const occurrences = indexes.length;
    if (documents.length <= occurrences) continue;
    const last = indexes.at(-1);
    if (last === undefined) continue;
    statements[last]!.rowsAppended += documents
      .slice(occurrences)
      .reduce<number>((total, document) => total + rowsAppended(document), 0);
  }
  return statements;
}

const statementBudgets: Readonly<Record<Seed['scenario'], readonly StatementBudgetTerm[]>> = Object.freeze(
  Object.fromEntries(
    (['new', 'unchanged', 'changed', 'revision', 'mass-disappearance', 'vanished-page', 'bulk'] as const).map(
      (scenario) => [
        scenario,
        [
          {
            engine: 'sqlite',
            method: 'RunStore stage, classify, dispatch and acknowledge',
            derivation:
              'services/importer/src/run-store.ts begin/stage/seal/pageStaged/key/plan/acknowledge/finalize use bounded point and page branches; the record loop contributes perItem',
            fixed: 1200,
            perItem: 80,
            perField: 0,
          },
          {
            engine: 'sqlite',
            method: 'RecordBindings prepare and acknowledge',
            derivation:
              'services/importer/src/record-bindings.ts prepare and acknowledge: bootstrap 6+6, first proposal 9+7, later proposal 8+7 statements, plus bounded transaction controls',
            fixed: 256,
            perItem: 64,
            perField: 32,
          },
          {
            engine: 'postgres',
            method: 'Kernel, Auth, Access, receipts and content writes',
            derivation:
              'services/kernel/src/http/kernel.ts and services/kernel/src/access/: each authenticated public request has bounded request, actor, permission, receipt, fence and routed content branches',
            fixed: 4000,
            perItem: 1000,
            perField: 256,
          },
        ],
      ],
    ),
  ) as Record<Seed['scenario'], StatementBudgetTerm[]>,
);

export async function openImportGrowthFixture(): Promise<ImportGrowthDriver> {
  const sqlite = createGrowthSqliteCapture();
  const memory: MeasuredMemory = { allocated: 0, peakBytes: 0, peakRecords: 0 };
  const retainedPages = new Map<string, { bytes: number; records: number }>();
  const activeRecords = new Set<string>();
  const sampleMemory = () => {
    const bytes = [...retainedPages.values()].reduce((sum, page) => sum + page.bytes, 0);
    const records = [...retainedPages.values()].reduce((sum, page) => sum + page.records, 0) + activeRecords.size;
    memory.peakBytes = Math.max(memory.peakBytes, bytes);
    memory.peakRecords = Math.max(memory.peakRecords, records);
  };
  const observer = {
    onPageRetained(
      phase: 'staged' | 'vanished' | 'resumed' | 'media',
      records: readonly { recordKey: string; bytes: number }[],
    ) {
      const retainedBytes = records.reduce((sum, record) => sum + record.bytes, 0);
      memory.allocated += retainedBytes;
      retainedPages.set(phase, { bytes: retainedBytes, records: records.length });
      sampleMemory();
    },
    onRecordActive(phase: 'staged' | 'vanished' | 'resumed' | 'media', key: string, active: boolean) {
      const entry = `${phase}:${key}`;
      if (active) activeRecords.add(entry);
      else activeRecords.delete(entry);
      sampleMemory();
    },
  };
  const runtime = await openApiRuntime(
    { batchRecords: 8, maxFields: 64, maxRecordBytes: 65536 },
    sqlite,
    observer,
    // The kernel caps a bulk envelope at 100 commands; use the limiter's maximum startup budget for this test identity.
    { maximum: 1_000_000, seconds: 86_400 },
  );
  await runtime.rateLimit({ requests: 1000, windowMs: 60000, nowMs: Date.now() });
  const population = createApiPopulation(runtime);
  let state: GrowthState | undefined;
  let reader: { counters: DumpCounters; bytes: number; fields: number; peakBytes: number } | undefined;
  let manualRequests = 0;
  let manualRequestBytes = 0;
  let manualPeakBytes = 0;
  let measurementSequence = 0;
  let seedSequence = 0;
  let ownedSource = 'growth-source';
  const store = runtime.importer.session.store;
  const bindings = runtime.importer.session.bindings;
  const fixturePartitions = new Set<string>();
  const accountRoute = routeOf(runtime.identity.bulk.accountId)!;
  fixturePartitions.add(String(partitionOf(accountRoute)));
  fixturePartitions.add(String(population.population.hotPartition));
  fixturePartitions.add(String(partitionOf(0)));

  function anchor(source: string, externalId: string, subject?: string) {
    fixturePartitions.add(String(partitionOf(tupleRoute(runtime.identity.routeKey, source, externalId))));
    if (subject) fixturePartitions.add(String(partitionOf(routeOf(subject)!)));
    if (state) state.fixture.partitions = [...new Set([...state.fixture.partitions, ...fixturePartitions])];
  }

  function recordFor(seed: Readonly<Seed>, phase: 'same' | 'before' | 'after' | 'new', index = 0): RecordValue {
    const id = index === 0 ? 1 : 900000 + index;
    const name =
      phase === 'same'
        ? 'Growth fixed'
        : phase === 'before'
          ? itemName(seed, 'Growth original')
          : phase === 'after'
            ? itemName(seed, 'Growth changed')
            : itemName(seed, 'Growth new');
    return { id, type: 1, name, tags: Array.from({ length: seed.fields }, (_, i) => ({ name: `tag-${i + 1}` })) };
  }

  function sourceRecord(record: RecordValue): SourceRecord {
    return { source: 'bangumi', key: external(record), revision: null, payload: record };
  }

  async function importRecords(source: string, converterRevision: string, records: readonly SourceRecord[]) {
    const registration = createSourceRegistration('bangumi', { source, converterRevision });
    return runtime.importer.runRecords(
      registration,
      (async function* () {
        for (const record of records) yield record;
      })(),
      { collectionLimit: 1000 },
    );
  }

  function stage(source: string, converterRevision: string, records: readonly RecordValue[]) {
    const registration = createSourceRegistration('bangumi', { source, converterRevision });
    const run = store.begin(source);
    if (run === 'busy') throw new Error(`Growth run is busy: ${source}`);
    for (const record of records) {
      const key = external(record);
      const conversion = registration.convert({ external_id: key, record_revision: null, record }, { source });
      store.stage(run, {
        row: {
          source,
          recordKey: key,
          recordRevision: conversion.record_revision ?? 'unversioned',
          digest: conversion.digest,
          converter_revision: converterRevision,
          state: 'present',
        },
        projection: { sourceKind: 'bangumi', normalizedRecord: conversion.normalized },
      });
    }
    const seal = store.seal(run, { complete: true });
    return { run, seal };
  }

  async function resetNewKey() {
    store.database.transaction(() => {
      store.database.query('DELETE FROM run_acknowledged WHERE source=? AND record_key=?').run(ownedSource, '1');
      store.database.query('DELETE FROM run_members WHERE source=? AND record_key=?').run(ownedSource, '1');
      store.database.query('UPDATE run_sources SET generation=NULL,present_count=0 WHERE source=?').run(ownedSource);
    })();
  }

  async function prepareRegular(seed: Readonly<Seed>) {
    if (seed.scenario === 'new') {
      await resetNewKey();
      const candidate = recordFor(seed, 'new');
      stage(ownedSource, `growth-new-${seed.n}-${seed.history}-${seed.fields}`, [candidate]);
      return;
    }
    if (seed.scenario === 'mass-disappearance') {
      const baseline = Array.from({ length: 16 }, (_, index) => recordFor(seed, 'same', index));
      await importRecords(
        ownedSource,
        'growth-mass-v1',
        baseline.map((record) => sourceRecord(record)),
      );
      const empty = stage(ownedSource, 'growth-mass-v1', []);
      if (empty.seal.status !== 'mass-disappearance') throw new Error('Expected the real mass-disappearance guard');
      return;
    }
    const baseline = recordFor(seed, seed.scenario === 'unchanged' ? 'same' : 'before');
    const revision =
      seed.scenario === 'revision' ? `growth-base-${seed.n}-${seed.history}-${seed.fields}` : 'growth-v1';
    await importRecords(ownedSource, revision, [sourceRecord(baseline)]);
    const candidate =
      seed.scenario === 'unchanged' ? baseline : seed.scenario === 'revision' ? baseline : recordFor(seed, 'after');
    const currentRevision =
      seed.scenario === 'revision' ? `growth-next-${seed.n}-${seed.history}-${seed.fields}` : revision;
    const staged = stage(ownedSource, currentRevision, [candidate]);
    if (staged.seal.status !== 'ready')
      throw new Error(`Expected ready staged source run; received ${staged.seal.status}`);
  }

  async function prepareBulk(seed: Readonly<Seed>) {
    const records = Array.from({ length: seed.fields }, (_, index) => {
      const id = 10000 + index;
      return { id, type: 1, name: `Bulk source ${id}`, tags: [] };
    });
    const imported = await importRecords(ownedSource, 'growth-bulk-v1', records.map(sourceRecord));
    if (imported.status !== 'committed') throw new Error(`Bulk baseline did not commit: ${imported.status}`);
    for (const record of records) {
      const claim = bindings.claim({ source: ownedSource, external_id: external(record) });
      if (claim?.state !== 'bound') throw new Error(`Bulk baseline did not bind record ${external(record)}`);
      anchor(ownedSource, external(record), claim.subject);
    }
  }

  async function prepareVanishedPage(fixture: Fixture) {
    const baselineCount = 96;
    const baselineRecords = Array.from({ length: baselineCount }, (_, index) => {
      const id = 900000 + index;
      return { id, type: 1, name: `Vanished baseline ${id}`, tags: [] };
    });
    const vanished = Array.from({ length: 16 }, (_, index) => String(900000 + index));
    const baseline = await importRecords(ownedSource, 'growth-page-v1', baselineRecords.map(sourceRecord));
    if (baseline.status !== 'committed') throw new Error(`Vanished baseline did not commit: ${baseline.status}`);
    const decoy = stage(`${ownedSource}-decoy`, 'growth-page-v1', baselineRecords);
    if (decoy.seal.status !== 'ready') throw new Error('Vanished-page decoy generation was not ready');
    const stagedRecords = baselineRecords.slice(vanished.length);
    const staged = stage(ownedSource, 'growth-page-v1', stagedRecords);
    if (staged.seal.status !== 'ready')
      throw new Error('Vanished page seed did not remain below disappearance threshold');
    state!.run = staged.run;
    state!.vanished = vanished;
    fixture.vanishedKeys = vanished;
    for (const key of vanished) {
      const claim = bindings.claim({ source: ownedSource, external_id: key });
      if (claim?.state !== 'bound') throw new Error(`Vanished baseline ${key} has no actual subject binding`);
      anchor(ownedSource, key, claim.subject);
    }
  }

  async function preparePrivateSubjects(source = state!.privateSource) {
    const records = Array.from({ length: 3 }, (_, index) => ({
      id: 200000 + index,
      type: 1,
      name: `Private plan subject ${index + 1}`,
      tags: [],
    }));
    const imported = await importRecords(source, 'growth-private-v1', records.map(sourceRecord));
    if (imported.status !== 'committed') throw new Error(`Private-plan subjects did not commit: ${imported.status}`);
    for (const record of records) {
      const owner = { source, external_id: external(record) };
      const claim = bindings.claim(owner);
      if (claim?.state !== 'bound') throw new Error(`Private-plan subject ${owner.external_id} was not bound`);
      anchor(source, owner.external_id, claim.subject);
      const current = bindings.candidates(owner, 'facts', { limit: 100 });
      const retractions: BatchCommand[] = current.map((candidate) => {
        const prior = (JSON.parse(candidate.bytes) as BatchWriteRequest).commands[0]!;
        if (prior.op !== 'propose') throw new Error('Private-plan candidate lacks its actual proposal');
        const command: BatchCommand = {
          op: 'retract',
          key: bindingKey(owner, `private-plan-clear:${candidate.candidate}`),
          source: prior.source,
          subject: claim.subject,
          candidate: candidate.candidate,
          references: prior.statement.references,
        };
        bindings.prepare(owner, candidate.signature, { commands: [command] });
        return command;
      });
      for (const batch of await runtime.importTransport.batches(retractions))
        for (const result of batch.results) {
          if (result.status !== 200 && result.status !== 201)
            throw new Error('Private-plan candidate cleanup was rejected');
          bindings.acknowledge(owner, result.key, { results: [result] });
        }
    }
  }

  async function nativeGrowthCapture(operation: () => Promise<unknown>) {
    const { phases, sqliteStatements, sqlite: sqliteMetadata } = await runtime.measureGrowth(operation);
    const postgres = phases.api.postgres;
    const pgStatements = postgresStatements(postgres);
    if (!state) throw new Error('Growth seed must precede every measurement');
    const raw = {
      ...postgres,
      statements: [...postgres.statements],
      plans: [...postgres.plans],
    } as Capture;
    const indexPlans = await runtime.measurement.indexPlans();
    const statements = [...sqliteStatements, ...pgStatements];
    return {
      statements,
      postgres: raw,
      indexPlans,
      sqlite: sqliteMetadata,
      counters: phases,
      pgStatements,
    };
  }

  async function runBulkReplacement(count: number): Promise<Outcome> {
    const beforeRequest = runtime.captures.length;
    const commands: BatchCommand[] = [];
    for (let index = 0; index < count; index++) {
      const id = 10000 + index;
      const owner = { source: ownedSource, external_id: String(id) };
      const claim = bindings.claim(owner);
      if (claim?.state !== 'bound') throw new Error(`Bulk baseline did not bind record ${id}`);
      await runtime.importTransport.fence({ source: ownedSource, externalId: String(id), fieldGroup: 'facts' });
      const current = bindings.candidates(owner, 'facts', { limit: 100 });
      const priorCandidate = current.find((candidate) => {
        const prior = (JSON.parse(candidate.bytes) as BatchWriteRequest).commands[0]!;
        return prior.op === 'propose' && prior.statement.property.id === 'schema:name';
      });
      if (!priorCandidate) throw new Error(`Bulk baseline title was not bound for record ${id}`);
      const prior = (JSON.parse(priorCandidate.bytes) as BatchWriteRequest).commands[0]!;
      if (prior.op !== 'propose') throw new Error('Bulk candidate lacks its actual proposal');
      const converted = convertBangumi(
        {
          external_id: String(id),
          record_revision: null,
          record: {
            id,
            type: 1,
            name: `${itemName(state!.seed, 'Bulk changed')} ${id}`,
            tags: [],
          },
        },
        { source: ownedSource, subjectId: claim.subject },
        { converterRevision: 'growth-bulk-v1' },
      );
      const replacement = converted.proposals.find(
        (command) => command.op === 'propose' && command.statement.property.id === 'schema:name',
      );
      if (!replacement || replacement.op !== 'propose')
        throw new Error('Bulk replacement converter produced no source title proposal');
      const retract: BatchCommand = {
        op: 'retract',
        key: bindingKey(owner, `bulk-retract:${measurementSequence}:${priorCandidate.candidate}`),
        source: replacement.source,
        subject: claim.subject,
        candidate: priorCandidate.candidate,
        references: prior.statement.references,
      };
      const propose: BatchCommand = {
        ...replacement,
        key: bindingKey(owner, `bulk-propose:${measurementSequence}:${replacement.key}`),
      };
      bindings.prepare(owner, converted.digest, { commands: [retract] });
      bindings.prepare(owner, converted.digest, { commands: [propose] });
      commands.push(retract, propose);
    }
    memory.peakRecords = Math.max(memory.peakRecords, count);
    const retainedPlanBytes = commands.reduce((sum, command) => sum + Buffer.byteLength(JSON.stringify(command)), 0);
    memory.allocated += retainedPlanBytes;
    memory.peakBytes = Math.max(memory.peakBytes, retainedPlanBytes);
    const preparedOwners = new Map<string, { source: string; external_id: string }>();
    for (let index = 0; index < count; index++) {
      const owner = { source: ownedSource, external_id: String(10000 + index) };
      preparedOwners.set(commands[index * 2]!.key, owner);
      preparedOwners.set(commands[index * 2 + 1]!.key, owner);
    }
    for (const batch of await runtime.importTransport.batches(commands))
      for (const result of batch.results) {
        if (result.status !== 200 && result.status !== 201)
          throw new Error(`Bulk replacement public write was rejected: ${result.status}`);
        const owner = preparedOwners.get(result.key);
        if (!owner) throw new Error('Bulk replacement response was not prepared');
        bindings.acknowledge(owner, result.key, { results: [result] });
      }
    const envelopes = runtime.captures
      .slice(beforeRequest)
      .filter((capture) => new URL(capture.request.url).pathname === '/v1/subjects:batchWrite')
      .map((capture) => capture.body);
    return {
      status: 'completed',
      publicWrites: count,
      fenceChecks: runtime.captures
        .slice(beforeRequest)
        .filter((capture) => new URL(capture.request.url).pathname.toLowerCase().includes('sourcefences')).length,
      serverFenceChecks: 0,
      visitedKeys: [],
      envelopes,
    };
  }

  async function runPrivatePlan(): Promise<Outcome> {
    const beforeRequest = runtime.captures.length;
    const commands: BatchCommand[] = [];
    const prepared = new Map<string, { owner: { source: string; external_id: string } }>();
    const source = state!.privateSource;
    const externalId = '200000';
    const owner = { source, external_id: externalId };
    const claim = bindings.claim(owner);
    if (claim?.state !== 'bound') throw new Error('Private-plan subject was not seeded');
    const registration = createSourceRegistration('bangumi', { source, converterRevision: 'growth-private-plan-v1' });
    const converted = registration.convert(
      {
        external_id: externalId,
        record_revision: null,
        record: { id: Number(externalId), type: 1, name: 'Private plan template', tags: [] },
      },
      { source, subjectId: claim.subject },
    );
    const template = converted.proposals.find(
      (entry) => entry.op === 'propose' && entry.statement.property.id === 'schema:name',
    );
    if (!template || template.op !== 'propose')
      throw new Error('Private-plan converter lacks its source title proposal');
    for (let index = 0; index < 300; index++) {
      const owner = { source, external_id: String(200000 + Math.floor(index / 100)) };
      const ownerClaim = bindings.claim(owner);
      if (ownerClaim?.state !== 'bound') throw new Error(`Private-plan owner ${owner.external_id} was not bound`);
      const registrationForOwner = createSourceRegistration('bangumi', {
        source,
        converterRevision: 'growth-private-plan-v1',
      });
      const ownerRecord = {
        external_id: owner.external_id,
        record_revision: null,
        record: {
          id: Number(owner.external_id),
          type: 1,
          name: `Private plan template ${owner.external_id}`,
          tags: [],
        },
      };
      const ownerConversion = registrationForOwner.convert(ownerRecord, {
        source,
        subjectId: ownerClaim.subject,
      });
      const ownerTemplate = ownerConversion.proposals.find(
        (entry) => entry.op === 'propose' && entry.statement.property.id === 'schema:name',
      );
      if (!ownerTemplate || ownerTemplate.op !== 'propose')
        throw new Error(`Private-plan converter lacks a title proposal for ${owner.external_id}`);
      const statement = structuredClone(ownerTemplate.statement);
      if (statement.value.type !== 'value' || !statement.value.content || typeof statement.value.content !== 'object')
        throw new Error('Private-plan template is not a structured value');
      const content = statement.value.content as { language: string; text: string };
      content.text = `Private ${String(index).padStart(3, '0')} ${'x'.repeat(1000)}`;
      const command: BatchCommand = {
        ...ownerTemplate,
        key: bindingKey(owner, `private-plan:${measurementSequence}:${index}`),
        statement,
      };
      bindings.prepare(owner, ownerConversion.digest, { commands: [command] });
      commands.push(command);
      prepared.set(command.key, { owner });
    }
    const retainedPlanBytes = commands.reduce((sum, command) => sum + Buffer.byteLength(JSON.stringify(command)), 0);
    memory.allocated += retainedPlanBytes;
    memory.peakBytes = Math.max(memory.peakBytes, retainedPlanBytes);
    memory.peakRecords = Math.max(memory.peakRecords, commands.length);
    const results = await runtime.importTransport.batches(commands);
    for (const batch of results)
      for (const result of batch.results) {
        const item = prepared.get(result.key);
        if (!item) throw new Error('Private-plan response was not prepared');
        bindings.acknowledge(item.owner, result.key, { results: [result] });
        if (result.status !== 200 && result.status !== 201) throw new Error('Private-plan public write was rejected');
        const id = 'value' in result && 'id' in result.value ? result.value.id : undefined;
        if (id) anchor(source, item.owner.external_id, id);
      }
    const envelopes = runtime.captures
      .slice(beforeRequest)
      .filter((capture) => new URL(capture.request.url).pathname === '/v1/subjects:batchWrite')
      .map((capture) => capture.body);
    return {
      status: 'completed',
      publicWrites: 300,
      fenceChecks: 0,
      serverFenceChecks:
        runtime.measurement.active?.api.postgres.statements.filter((sql) => /fence/i.test(sql)).length ?? 0,
      visitedKeys: [],
      envelopes,
    };
  }

  async function runVanishedPage(cursor?: string): Promise<Outcome> {
    const current = state!;
    const run = current.run;
    if (!run) throw new Error('Vanished-page run was not staged');
    const page = store.pageVanished(run, { ...(cursor === undefined ? {} : { after: cursor }), limit: 8 });
    const visited = page.map((row) => row.recordKey);
    const retainedPageBytes = page.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0);
    memory.allocated += retainedPageBytes;
    memory.peakBytes = Math.max(memory.peakBytes, retainedPageBytes);
    memory.peakRecords = Math.max(memory.peakRecords, page.length);
    const beforeRequest = runtime.captures.length;
    let writes = 0;
    let fenceChecks = 0;
    for (const key of visited) {
      const record = { id: Number(key), type: 1, name: `Vanished page ${key}`, tags: [] };
      const owner = { source: ownedSource, external_id: key };
      await runtime.importTransport.fence({ source: ownedSource, externalId: key, fieldGroup: 'facts' });
      fenceChecks++;
      const claim = bindings.claim(owner);
      if (claim?.state !== 'bound') throw new Error(`Vanished record ${key} has no seeded RecordBindings entry`);
      const revision = `growth-page-${current.seed.n}-${current.seed.history}-${current.seed.fields}-${measurementSequence}`;
      const converted = convertBangumi(
        { external_id: key, record_revision: null, record: { ...record, name: `${record.name} ${revision}` } },
        { source: ownedSource, subjectId: claim.subject },
        { converterRevision: revision },
      );
      const candidate = converted.proposals.find(
        (entry) => entry.op === 'propose' && entry.statement.property.id === 'schema:name',
      );
      if (!candidate || candidate.op !== 'propose') throw new Error('Vanished page converter produced no proposal');
      const proposal = { ...candidate, key: bindingKey(owner, `vanished:${candidate.key}:${measurementSequence}`) };
      bindings.prepare(owner, converted.digest, { commands: [proposal] });
      const [batch] = await runtime.importTransport.batches([proposal]);
      const response = batch?.results[0];
      if (!response || (response.status !== 200 && response.status !== 201))
        throw new Error('Vanished page public write was rejected');
      try {
        bindings.acknowledge(owner, proposal.key, { results: [response] });
      } catch (error) {
        const candidateIds = bindings
          .candidates(owner, proposal.source.field_group, { limit: 100 })
          .map((entry) => entry.candidate);
        throw new Error(
          `Vanished-page binding acknowledgement failed for ${key}: response=${JSON.stringify(response)}, claim=${JSON.stringify(claim)}, journal=${Boolean(bindings.journal(owner, proposal.key))}, candidate=${'value' in response && 'candidate' in response.value ? response.value.candidate : '<missing>'}, candidateExists=${candidateIds.includes('value' in response && 'candidate' in response.value ? response.value.candidate : '')}`,
          { cause: error },
        );
      }
      current.pageWrites.set(key, { subject: claim.subject });
      writes++;
    }
    const requestCount = runtime.captures
      .slice(beforeRequest)
      .filter((capture) => new URL(capture.request.url).pathname === '/v1/subjects:batchWrite').length;
    if (requestCount < visited.length)
      throw new Error('Vanished page did not issue a public write for every visited key');
    for (const key of visited) anchor(ownedSource, key, current.pageWrites.get(key)?.subject);
    return {
      status: 'completed',
      publicWrites: writes,
      fenceChecks,
      serverFenceChecks:
        runtime.measurement.active?.api.postgres.statements.filter((sql) => /fence/i.test(sql)).length ?? 0,
      visitedKeys: visited,
      ...(visited.length ? { nextCursor: visited.at(-1)! } : {}),
    };
  }

  async function run(operation: Readonly<Operation | WarmScenarioOperation>): Promise<Outcome> {
    if (operation.kind === 'convert') {
      const input = JSON.parse(Buffer.from(operation.input).toString('utf8')) as ConversionInput;
      const source = operation.exportPath.includes('bangumi')
        ? convertBangumi
        : operation.exportPath.includes('vndb')
          ? convertVndb
          : operation.exportPath.includes('wikidata')
            ? convertWikidata
            : operation.exportPath.includes('open-library')
              ? convertOpenLibrary
              : undefined;
      if (!source) throw new Error(`Unknown converter export path: ${operation.exportPath}`);
      try {
        return {
          status: 'completed',
          publicWrites: 0,
          fenceChecks: 0,
          serverFenceChecks: 0,
          visitedKeys: [],
          actualReturn: source(input),
        };
      } catch (error) {
        if (!(error instanceof ConversionError)) throw error;
        if (
          !/^(?:invalid_record_byte_limit|invalid_record_tag_limit|Allowed dump projection exceeds 64 KiB|Dump row count exceeds source cap|Source record exceeds 128 KiB|Source term limit exceeded|Source snak limit exceeded|Source statement limit exceeded|source_field_limit_64|source_record_byte_limit_2_MiB)$/u.test(
            error.code,
          )
        )
          throw error;
        return { status: 'record-too-large', publicWrites: 0, fenceChecks: 0, serverFenceChecks: 0, visitedKeys: [] };
      }
    }
    if (operation.kind === 'public-bulk') {
      const commands = Array.from({ length: operation.commands }, (_, index) => ({
        op: 'create',
        key: `oversize-${index}`,
        source: {
          source: 'growth-source',
          external_id: `oversize-${index}`,
          record_revision: '1',
          converter_revision: 'growth-v1',
          digest: hash(`oversize-${index}`),
          field_group: 'facts',
        },
        subject: { type: 'schema:Book', labels: { und: `Oversized ${index}` } },
      }));
      const body = JSON.stringify({ commands });
      manualRequests++;
      manualRequestBytes += Buffer.byteLength(body);
      manualPeakBytes = Math.max(manualPeakBytes, Buffer.byteLength(body));
      const response = await runtime.request('/v1/subjects:batchWrite', { commands }, runtime.bulk.bearer);
      if (response.status < 400) throw new Error(`Oversized public batch unexpectedly passed: ${response.status}`);
      return { status: 'batch-too-large', publicWrites: 0, fenceChecks: 0, serverFenceChecks: 0, visitedKeys: [] };
    }
    if (operation.kind === 'private-plan') return runPrivatePlan();
    if (operation.kind === 'vanished-page') return runVanishedPage(operation.cursor);
    if (operation.kind === 'bulk') return runBulkReplacement(operation.fields);

    const registration = createSourceRegistration('bangumi', {
      source: ownedSource,
      converterRevision:
        state?.seed.scenario === 'revision'
          ? `growth-next-${state.seed.n}-${state.seed.history}-${state.seed.fields}`
          : state?.seed.scenario === 'new'
            ? `growth-new-${state.seed.n}-${state.seed.history}-${state.seed.fields}`
            : state?.seed.scenario === 'mass-disappearance'
              ? 'growth-mass-v1'
              : 'growth-v1',
    });
    const beforeCapture = runtime.captures.length;
    const records = (async function* () {
      if (operation.kind === 'mass-disappearance') return;
      const seed = state!.seed;
      const record = recordFor(
        seed,
        seed.scenario === 'unchanged' ? 'same' : seed.scenario === 'new' ? 'new' : 'after',
      );
      yield { source: 'bangumi' as const, key: '1', revision: null, payload: { ...record, id: 1 } };
    })();
    const result = await runtime.importer.runRecords(registration, records, { collectionLimit: 1000 });
    const captures = runtime.captures.slice(beforeCapture);
    const fences = captures.filter((capture) =>
      new URL(capture.request.url).pathname.toLowerCase().includes('sourcefences'),
    ).length;
    const postgres = runtime.measurement.active?.api.postgres ?? emptyCapture();
    const serverFences = postgres.statements.filter((sql) => /fence/i.test(sql)).length;
    const publicWrites = result.new.length + result.changed.length;
    if (result.status !== 'committed' && result.status !== 'mass-disappearance')
      throw new Error(`Unexpected production import status: ${result.status}`);
    return {
      status: result.status === 'mass-disappearance' ? 'mass-disappearance-blocked' : 'completed',
      publicWrites,
      fenceChecks: fences,
      serverFenceChecks: serverFences,
      visitedKeys: [],
    };
  }

  async function warmScenario(seed: Readonly<Seed>, fixture: Fixture) {
    const measuredState = state;
    if (!measuredState) throw new Error('Growth warm-up requires a staged measured seed');
    const measuredSource = ownedSource;
    const measuredPartitions = [...fixturePartitions];
    const warmSource = `gw-${seed.scenario}-${measurementSequence}`;
    const warmFixture: Fixture = { ...fixture, partitions: [], vanishedKeys: [] };
    const warmState: GrowthState = {
      seed,
      fixture: warmFixture,
      privateSource: `gwp-${seed.scenario}-${measurementSequence}`,
      vanished: [],
      pageWrites: new Map(),
    };
    try {
      state = warmState;
      ownedSource = warmSource;
      measurementSequence++;
      if (seed.scenario === 'vanished-page') {
        await prepareVanishedPage(warmFixture);
        const first = await run({
          kind: 'vanished-page',
          source: warmSource,
          key: seed.key,
          fields: seed.fields,
          pageCap: B,
        });
        if (first.nextCursor)
          await run({
            kind: 'vanished-page',
            source: warmSource,
            key: seed.key,
            fields: seed.fields,
            pageCap: B,
            cursor: first.nextCursor,
          });
      } else if (seed.scenario === 'bulk') {
        await prepareBulk(seed);
        await run({ kind: 'bulk', source: warmSource, key: seed.key, fields: seed.fields, pageCap: B });
        if (seed.fields === 64) {
          await preparePrivateSubjects();
          await run({ kind: 'private-plan', commands: 300, byteHeavy: true });
        }
      } else {
        await prepareRegular(seed);
        await run({
          kind: seed.scenario,
          source: warmSource,
          key: seed.key,
          fields: seed.fields,
          pageCap: B,
        });
      }
    } finally {
      state = measuredState;
      ownedSource = measuredSource;
      fixturePartitions.clear();
      for (const partition of measuredPartitions) fixturePartitions.add(partition);
    }
  }

  return {
    statementBudgets,
    async seed(options: Readonly<Seed>): Promise<Fixture> {
      if (options.source !== 'growth-source' || options.key !== 'fixed-record')
        throw new Error('Unexpected growth seed');
      const scenarioSequence = seedSequence++;
      const scenarioSource = options.scenario === 'vanished-page' ? 'vanished' : options.scenario;
      ownedSource =
        options.scenario === 'new' || options.scenario === 'vanished-page'
          ? `g-${scenarioSource}-${scenarioSequence}`
          : options.source;
      await population.seed({ catalogueRecords: options.n, historyRows: options.history });
      fixturePartitions.clear();
      fixturePartitions.add(String(partitionOf(accountRoute)));
      fixturePartitions.add(String(population.population.hotPartition));
      fixturePartitions.add(String(partitionOf(0)));
      const converters = converterFixtures(options.fields);
      const fixture: Fixture = {
        converters,
        dumpRecord: bytes(`${JSON.stringify({ id: 1, type: 1, name: `Growth dump ${'x'.repeat(400)}` })}\n`),
        dumpAtCap: framedDump(65536),
        dumpOverCap: framedDump(65537),
        partitions: [...fixturePartitions],
        vanishedKeys: [],
      };
      state = {
        seed: options,
        fixture,
        privateSource: `gp-${scenarioSource}-${scenarioSequence}`,
        vanished: [],
        pageWrites: new Map(),
      };
      if (options.scenario !== 'bulk') anchor(ownedSource, '1');
      if (options.scenario === 'vanished-page') {
        await prepareVanishedPage(fixture);
      } else if (options.scenario === 'bulk') {
        await prepareBulk(options);
        if (options.fields === 64) await preparePrivateSubjects();
      } else {
        await prepareRegular(options);
        if (
          options.scenario === 'new' ||
          options.scenario === 'unchanged' ||
          options.scenario === 'changed' ||
          options.scenario === 'revision'
        ) {
          fixture.partitions = [
            ...new Set([
              ...fixture.partitions,
              String(partitionOf(tupleRoute(runtime.identity.routeKey, ownedSource, '1'))),
            ]),
          ];
          const claim = bindings.claim({ source: ownedSource, external_id: '1' });
          if (claim?.state === 'bound') anchor(ownedSource, '1', claim.subject);
        }
      }
      fixture.partitions = [...new Set([...fixture.partitions, ...fixturePartitions])];
      await warmScenario(options, fixture);
      return fixture;
    },
    async measure<T>(operation: () => Promise<T>): Promise<{ value: T; counters: Counters }> {
      measurementSequence++;
      let resultValue!: T;
      reader = undefined;
      memory.allocated = 0;
      memory.peakBytes = 0;
      memory.peakRecords = 0;
      retainedPages.clear();
      activeRecords.clear();
      const requestStart = runtime.captures.length;
      const manualRequestStart = manualRequests;
      const manualBytesStart = manualRequestBytes;
      const manualPeakStart = manualPeakBytes;
      const captured = await nativeGrowthCapture(async () => {
        resultValue = await operation();
        return resultValue;
      });
      const postgres = captured.postgres;
      const pg = captured.pgStatements;
      const outcome = resultValue as unknown as Partial<Outcome> | undefined;
      if (outcome && typeof outcome.serverFenceChecks === 'number')
        outcome.serverFenceChecks = postgres.statements.filter((sql) => /fence/i.test(sql)).length;
      const sqliteStatements = captured.statements.filter((statement) => statement.engine === 'sqlite');
      const observedRequests = runtime.captures.slice(requestStart);
      const networkRequests = observedRequests.length + manualRequests - manualRequestStart;
      const requestBytes =
        observedRequests.reduce((total, request) => total + Buffer.byteLength(request.body), 0) +
        manualRequestBytes -
        manualBytesStart;
      const requestPeak = Math.max(
        0,
        ...observedRequests.map((request) => Buffer.byteLength(request.body)),
        manualPeakBytes - manualPeakStart,
      );
      const readerSample = reader as
        | { counters: DumpCounters; bytes: number; fields: number; peakBytes: number }
        | undefined;
      const readerBytes = readerSample?.counters.pulledBytes ?? 0;
      const readerCopied = readerSample?.counters.copiedBytes ?? 0;
      const readerWork = (readerSample?.counters.scannedBytes ?? 0) + readerCopied;
      const readerRecords = (readerSample?.fields ?? 0) > 0 ? 1 : 0;
      const counters: Counters = {
        partitions: partitions(postgres),
        postgres,
        indexPlans: captured.indexPlans,
        sqlite: captured.sqlite,
        statements: captured.statements,
        networkRequests,
        workUnits: readerWork + sqliteStatements.length + pg.length + postgres.plans.length,
        allocatedBytes: readerBytes + readerCopied + requestBytes + memory.allocated,
        peakRetainedBytes: Math.max(readerSample?.peakBytes ?? 0, memory.peakBytes, requestPeak),
        peakRetainedRecords: Math.max(memory.peakRecords, readerRecords),
      };
      if (!Number.isSafeInteger(counters.networkRequests)) throw new Error('Invalid measured network request count');
      return { value: resultValue, counters };
    },
    run,
    stream(input: AsyncIterable<Uint8Array>, options: { pageCap: 8; recordByteCap: 65536 }): AsyncIterable<unknown> {
      const counters = createDumpCounters();
      let peakBytes = 0;
      let fields = 0;
      const stop = observeDumpRetention((sample) => (peakBytes = Math.max(peakBytes, sample.total)));
      const iterable = readDump('bangumi', input, { maxRecordBytes: options.recordByteCap, counters });
      return (async function* () {
        try {
          for await (const record of iterable) {
            fields++;
            yield record;
          }
        } finally {
          stop();
          reader = {
            counters,
            bytes: counters.pulledBytes,
            fields,
            peakBytes: Math.max(peakBytes, counters.peakRetainedBytes),
          };
        }
      })();
    },
    async close() {
      await runtime.close();
    },
  } as ImportGrowthDriver;
}
