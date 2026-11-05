import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  countedSample,
  countedViolations,
  type CountedCheck,
  type CountedValues,
} from '../../kernel/test/support/growth-counters.ts';
import { sqliteEvidence, type Entry } from '../../../specs/imports-vndb-tables-driver.ts';
import { VndbTablesStore } from '../src/vndb-tables.ts';
import { createSqliteProbe } from './support/sqlite-growth.ts';

const SOURCE = 'vndb';
const TABLES = ['vn', 'vn_titles', 'entry_meta'] as const;
const GROWING_TABLES = ['vndb_table_runs', 'vndb_table_rows', 'vndb_table_spool'];
const SCALES = [1, 8, 64] as const;
const BACKGROUND_ROWS_PER_SOURCE = 250;
type Sample = { scale: number; counted: ReturnType<typeof countedSample> };
const check: CountedCheck = {
  read: (counts) => counts as CountedValues,
  bounds: { 'sqlite returned rows': 'constant', 'sqlite statements': 'constant' },
  slack: {
    'sqlite returned rows': { absolute: 2, relative: 0.1 },
    'sqlite statements': { absolute: 0, relative: 0 },
  },
};
const encode = (text: string) => new TextEncoder().encode(text);
const fixtureNames = ['vn.header', 'vn', 'vn_titles.header', 'vn_titles', 'entry_meta.header', 'entry_meta'];
const fixtureText = (name: string) =>
  readFileSync(new URL(`../../../specs/fixtures/imports/vndb-tables/db/${name}`, import.meta.url), 'utf8');

type InternalOperations = {
  validate(source: string, runId: string): void;
  cleanup(source: string, runId: string): void;
};

function entry(path: string, text: string): Entry {
  const bytes = encode(text);
  return {
    path,
    kind: 'file',
    declaredBytes: bytes.byteLength,
    bytes: (async function* () {
      for (let offset = 0; offset < bytes.byteLength; offset += 4096) yield bytes.subarray(offset, offset + 4096);
    })(),
  };
}

function spooledArchive(): Entry[] {
  const entries = fixtureNames.map((name) => entry(`db/${name}`, fixtureText(name)));
  return [
    ...entries.filter((item) => !item.path.endsWith('.header')),
    ...entries.filter((item) => item.path.endsWith('.header')),
  ];
}

async function* stream(entries: Entry[]) {
  yield* entries;
}

function harness() {
  const directory = mkdtempSync(join(tmpdir(), 'vndb-tables-growth-'));
  const database = new Database(resolve(directory, 'tables.sqlite'));
  const asynchronousEvidence = sqliteEvidence();
  asynchronousEvidence.attach(database);
  const probe = createSqliteProbe(database, { growingTables: GROWING_TABLES });
  const store = new VndbTablesStore(database, { childRowsPerVn: 8, pageSize: 16 });

  return {
    database,
    store,
    probe,
    asynchronousEvidence,
    close() {
      probe.restore();
      database.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function runSql(database: Database, sql: string, ...parameters: (string | number | Uint8Array)[]) {
  database.query(sql).run(...parameters);
}

const sequence = `WITH RECURSIVE seq(n) AS (
  SELECT ?
  UNION ALL
  SELECT n + 1 FROM seq WHERE n < ?
) `;

/** Seed one earlier archive's production-shaped rows for each background key. */
function seedBackground(database: Database, source: string, prefix: string, firstUnit: number, lastUnit: number) {
  if (firstUnit > lastUnit) return;
  const from = (firstUnit - 1) * BACKGROUND_ROWS_PER_SOURCE + 1;
  const through = lastUnit * BACKGROUND_ROWS_PER_SOURCE;
  runSql(
    database,
    `${sequence}INSERT INTO vndb_table_runs
      (source,run_id,state,source_records,staged_rows,staged_bytes,child_cap)
    SELECT ?, ? || printf('%05d', n), 'ready', 1, 3, 128, 8 FROM seq`,
    from,
    through,
    source,
    prefix,
  );
  runSql(
    database,
    `${sequence}INSERT INTO vndb_table_rows (source,run_id,table_name,id,id_number,child,payload)
    SELECT ?, ? || printf('%05d', n), 'vn', 'v' || n, n, '', json_object('id','v' || n) FROM seq`,
    from,
    through,
    source,
    prefix,
  );
  runSql(
    database,
    `${sequence}INSERT INTO vndb_table_rows (source,run_id,table_name,id,id_number,child,payload)
    SELECT ?, ? || printf('%05d', n), 'vn_titles', 'v' || n, n, 'en',
      json_object('id','v' || n,'lang','en','official',json('true'),'title','Title ' || n,'latin',NULL)
    FROM seq`,
    from,
    through,
    source,
    prefix,
  );
  runSql(
    database,
    `${sequence}INSERT INTO vndb_table_rows (source,run_id,table_name,id,id_number,child,payload)
    SELECT ?, ? || printf('%05d', n), 'entry_meta', 'v' || n, n, '',
      json_object('id','v' || n,'created','2020-01-01','lastmod','2020-01-01',
        'revision',1,'num_edits',0,'num_users',0)
    FROM seq`,
    from,
    through,
    source,
    prefix,
  );

  for (const table of TABLES) {
    const raw =
      table === 'vn'
        ? encode(['v1', '\\N', '\\N', 'en', '0', '\\N', '\\N', '\\N', '0', '0', '0', '\\N', '\\N'].join('\t'))
        : table === 'vn_titles'
          ? encode(['v1', 'en', 't', 'title', '\\N'].join('\t'))
          : encode(['v1', '2020-01-01', '2020-01-01', '1', '0', '0'].join('\t'));
    runSql(
      database,
      `${sequence}INSERT INTO vndb_table_spool (source,run_id,table_name,sequence,raw)
      SELECT ?, ? || printf('%05d', n), ?, 1, ? FROM seq`,
      from,
      through,
      source,
      prefix,
      table,
      raw,
    );
  }
}

/** Add 500 runs and 1500 rows in each of rows/spool per unit across two sources. */
function seedScaleBackground(database: Database, source: string, firstUnit: number, lastUnit: number) {
  seedBackground(database, source, 'archive-', firstUnit, lastUnit);
  seedBackground(database, 'history', 'other-', firstUnit, lastUnit);
}

function seedRunRows(database: Database, source: string, run: string, count: number, state: string) {
  runSql(
    database,
    `INSERT INTO vndb_table_runs
      (source,run_id,state,source_records,staged_rows,staged_bytes,child_cap)
    VALUES (?,?,?,?,?,?,?)`,
    source,
    run,
    state,
    count,
    count * 3,
    count * 128,
    8,
  );
}

function seedCompleteRows(database: Database, source: string, run: string, count: number) {
  seedRunRows(database, source, run, count, 'ready');
  for (let index = 1; index <= count; index++) {
    const id = `v${index}`;
    runSql(
      database,
      `INSERT INTO vndb_table_rows VALUES (?,?,?,?,?,?,?)`,
      source,
      run,
      'vn',
      id,
      index,
      '',
      JSON.stringify({ id }),
    );
    runSql(
      database,
      `INSERT INTO vndb_table_rows VALUES (?,?,?,?,?,?,?)`,
      source,
      run,
      'vn_titles',
      id,
      index,
      'en',
      JSON.stringify({ id, lang: 'en', official: true, title: `Title ${index}`, latin: null }),
    );
    runSql(
      database,
      `INSERT INTO vndb_table_rows VALUES (?,?,?,?,?,?,?)`,
      source,
      run,
      'entry_meta',
      id,
      index,
      '',
      JSON.stringify({
        id,
        created: '2020-01-01',
        lastmod: '2020-01-01',
        revision: 1,
        num_edits: 0,
        num_users: 0,
      }),
    );
  }
}

function seedSpoolRows(database: Database, source: string, run: string, count: number) {
  const rows = {
    vn: encode(['v1', '\\N', '\\N', 'en', '0', '\\N', '\\N', '\\N', '0', '0', '0', '\\N', '\\N'].join('\t')),
    vn_titles: encode(['v1', 'en', 't', 'title', '\\N'].join('\t')),
    entry_meta: encode(['v1', '2020-01-01', '2020-01-01', '1', '0', '0'].join('\t')),
  };
  for (const table of TABLES)
    for (let sequenceNumber = 1; sequenceNumber <= count; sequenceNumber++)
      runSql(
        database,
        `INSERT INTO vndb_table_spool VALUES (?,?,?,?,?)`,
        source,
        run,
        table,
        sequenceNumber,
        rows[table],
      );
}

async function measureStage(
  evidence: ReturnType<typeof sqliteEvidence>,
  operation: () => Promise<void>,
): Promise<CountedValues> {
  evidence.start();
  try {
    await operation();
    const raw = evidence.finish();
    return { 'sqlite returned rows': raw.rows, 'sqlite statements': raw.statements };
  } catch (error) {
    evidence.cancel();
    throw error;
  }
}

function expectConstantGrowth(samples: Sample[]) {
  expect(countedViolations(check, samples)).toEqual([]);
}

test('VNDB staging stays within its bound as R grows', async () => {
  const h = harness();
  const samples: Sample[] = [];
  try {
    let seededUnits = 0;
    for (const scale of SCALES) {
      seedScaleBackground(h.database, SOURCE, seededUnits + 1, scale);
      seededUnits = scale;
      h.database.exec('ANALYZE');

      const run = `stage-${scale}`;
      h.store.begin(SOURCE, run);
      h.database.exec('ANALYZE');
      const counts = await measureStage(h.asynchronousEvidence, () =>
        h.store.stage(SOURCE, run, stream(spooledArchive())),
      );
      expect(h.store.inspect(SOURCE, run).state).toBe('ready');
      samples.push({ scale, counted: countedSample([check.read(counts, scale)]) });
    }
    expectConstantGrowth(samples);
  } finally {
    h.close();
  }
}, 120_000);

test('VNDB projection stays within its bound as R grows', () => {
  const h = harness();
  const samples: Sample[] = [];
  try {
    const source = 'projection';
    seedCompleteRows(h.database, source, 'projection-run', 17);
    let seededUnits = 0;
    for (const scale of SCALES) {
      seedScaleBackground(h.database, source, seededUnits + 1, scale);
      seededUnits = scale;
      h.database.exec('ANALYZE');

      const measured = h.probe.measure(() => h.store.page(source, 'projection-run', { after: null, limit: 16 }));
      h.probe.verifyPlans();
      expect(measured.value.records).toHaveLength(16);
      expect(measured.value.next).toBe('v16');
      samples.push({ scale, counted: countedSample([check.read(measured.counts, scale)]) });
    }
    expectConstantGrowth(samples);
  } finally {
    h.close();
  }
}, 120_000);

test('VNDB validation stays within its bound as R grows', () => {
  const h = harness();
  const samples: Sample[] = [];
  const source = 'validation';
  const validate = (h.store as unknown as InternalOperations).validate.bind(h.store);
  try {
    seedCompleteRows(h.database, source, 'validation-run', 33);
    let seededUnits = 0;
    for (const scale of SCALES) {
      seedScaleBackground(h.database, source, seededUnits + 1, scale);
      seededUnits = scale;
      h.database.exec('ANALYZE');

      const measured = h.probe.measure(() => validate(source, 'validation-run'));
      h.probe.verifyPlans();
      samples.push({ scale, counted: countedSample([check.read(measured.counts, scale)]) });
    }
    expectConstantGrowth(samples);
  } finally {
    h.close();
  }
}, 120_000);

test('VNDB cleanup stays within its bound as R grows', () => {
  const h = harness();
  const samples: Sample[] = [];
  const cleanup = (h.store as unknown as InternalOperations).cleanup.bind(h.store);
  try {
    const source = 'cleanup';
    let seededUnits = 0;
    for (const scale of SCALES) {
      seedScaleBackground(h.database, source, seededUnits + 1, scale);
      seededUnits = scale;
      const run = `cleanup-${scale}`;
      seedCompleteRows(h.database, source, run, 65);
      seedSpoolRows(h.database, source, run, 65);
      h.database.exec('ANALYZE');

      const measured = h.probe.measure(() => cleanup(source, run));
      h.probe.verifyPlans();
      expect(measured.value).toBeUndefined();
      samples.push({ scale, counted: countedSample([check.read(measured.counts, scale)]) });
    }
    expectConstantGrowth(samples);
  } finally {
    h.close();
  }
}, 120_000);
