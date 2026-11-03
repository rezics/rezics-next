import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countedSample, countedViolations, type CountedCheck } from '../../kernel/test/support/growth-counters.ts';
import { DumpPreview } from '../src/dump-preview.ts';
import { compareRetainedProjections, type SideProjection } from '../src/plan-comparison-diff.ts';
import { PlanComparison } from '../src/plan-comparison.ts';
import { COMPARISON_TABLES, PlanComparisonStore } from '../src/plan-comparison-store.ts';
import { RunStore, type SourceProjection } from '../src/run-store.ts';
import { createSqliteProbe } from './support/sqlite-growth.ts';

const fixture = (path: string) => new URL(`../../../specs/fixtures/imports/${path}`, import.meta.url);

function archive(): Uint8Array {
  const encoder = new TextEncoder();
  const member = (path: string, bytes: Uint8Array) => {
    const header = new Uint8Array(512);
    const put = (offset: number, text: string) => header.set(encoder.encode(text), offset);
    put(0, path);
    for (const offset of [100, 108, 116]) put(offset, '0000644\0');
    put(124, `${bytes.length.toString(8).padStart(11, '0')}\0`);
    put(136, '00000000000\0');
    put(148, '        ');
    put(156, '0');
    put(257, 'ustar\0');
    put(263, '00');
    put(148, `${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `);
    return Buffer.concat([header, bytes, new Uint8Array((512 - (bytes.length % 512)) % 512)]);
  };
  const parts: Uint8Array[] = [];
  for (const name of ['vn.header', 'vn', 'vn_titles.header', 'vn_titles', 'entry_meta.header', 'entry_meta']) {
    parts.push(member(`db/${name}`, readFileSync(fixture(`vndb-tables/db/${name}`))));
  }
  parts.push(new Uint8Array(1024));
  return Buffer.concat(parts);
}

async function dumpFile(directory: string, name: string, bytes: string | Uint8Array) {
  const path = join(directory, name);
  await writeFile(path, bytes);
  return path;
}

function wikidataItems(count: number, title = (index: number) => `Item ${index}`) {
  const items = Array.from({ length: count }, (_, index) => ({
    type: 'item',
    id: `Q${1000 + index}`,
    lastrevid: 10 + index,
    labels: { en: { language: 'en', value: title(index) } },
    descriptions: {},
    aliases: {},
    claims: {},
    sitelinks: {},
  }));
  return `[\n${items.map((item) => JSON.stringify(item)).join(',\n')}\n]\n`;
}

async function completedBaseline(path: string, keys: string[], generationHint = 'wikidata@1') {
  const database = new Database(path, { create: true, strict: true });
  const store = new RunStore<SourceProjection>(database, { projectionMode: 'source-record' });
  const source = 'wikidata';
  const run = store.begin(source);
  if (run === 'busy') throw new Error('expected generation');
  for (const key of keys) {
    store.stage(run, {
      row: {
        source,
        recordKey: key,
        recordRevision: '10',
        digest: 'a'.repeat(64),
        converter_revision: generationHint,
        state: 'present',
      },
      projection: { sourceKind: 'wikidata', normalizedRecord: { id: key, labels: { en: key } } },
    });
  }
  expect(store.seal(run, { complete: true }).status).toBe('ready');
  for (const key of keys) {
    store.classify(run, key, { commands: [] });
    store.acknowledgeNoEffects(run, key, { reason: 'no-owned-candidates' });
  }
  expect(store.finalize(run, 100)).toBe('complete');
  store.close();
}

async function persistPreview(
  directory: string,
  name: string,
  input: { source: 'bangumi' | 'vndb' | 'openlibrary' | 'wikidata'; dump: string; baseline?: string; sourceAlias?: string },
) {
  const output = join(directory, name);
  const preview = await DumpPreview.build({ ...input, outputDir: output });
  await preview.close();
  return output;
}

function side(overrides: Partial<SideProjection> & Pick<SideProjection, 'recordKey'>): SideProjection {
  return {
    kind: 'new',
    recordRevision: '1',
    digest: 'a'.repeat(64),
    converterRevision: 'wikidata-5',
    skipped: false,
    display: { sourceKind: 'wikidata', normalized: { labels: { en: 'Lantern' }, aliases: {} }, mediaIntents: [] },
    operations: [],
    provenance: { source: 'wikidata', sourceKind: 'wikidata', externalId: overrides.recordKey },
    diagnostics: [],
    ...overrides,
  };
}

test('structured diff reports nested native values, unresolved targets and ordered evidence', () => {
  const left = side({
    recordKey: 'Q1',
    operations: [
      {
        operation: 'propose',
        fieldGroup: 'facts',
        property: { id: 'wdt:P186' },
        value: { type: 'somevalue' },
        unresolvedTarget: true,
        qualifiers: [{ property: { id: 'schema:sameAs' }, value: { type: 'value', content: 'http://www.wikidata.org/entity/Q2' } }],
        references: [
          { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.test/a' } }] },
          { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.test/b' } }] },
          { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.test/b' } }] },
        ],
      },
      {
        operation: 'propose',
        fieldGroup: 'facts',
        property: { id: 'schema:duration' },
        value: { type: 'value', content: { amount: '+12', unit: '1', lowerBound: '+11', upperBound: '+13' } },
      },
      {
        operation: 'propose',
        fieldGroup: 'facts',
        property: { id: 'schema:datePublished' },
        value: { type: 'value', content: { time: '+2020-00-00T00:00:00Z', precision: 9, calendarmodel: 'http://www.wikidata.org/entity/Q1985727' } },
      },
    ],
    display: {
      normalized: { labels: { en: 'Lantern' }, aliases: { en: ['Lamp', 'Light'] } },
      mediaIntents: [{ kind: 'media-intent', role: 'cover', rightsHolder: 'A', license: 'CC-BY-SA-3.0', via: 'bangumi' }],
      sourceStatistic: { kind: 'source-statistic', source: 'vndb', count: 10, mean: 8, note: 'Source statistic only; not a local vote or publication.' },
    },
  });
  const right = side({
    recordKey: 'Q1',
    digest: 'b'.repeat(64),
    converterRevision: 'wikidata-6',
    operations: [
      {
        operation: 'propose',
        fieldGroup: 'facts',
        property: { id: 'wdt:P186' },
        value: { type: 'value', content: '00000000-0000-4000-8000-000000000002' },
        unresolvedTarget: false,
        qualifiers: [{ property: { id: 'schema:sameAs' }, value: { type: 'value', content: 'http://www.wikidata.org/entity/Q2' } }],
        references: [
          { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.test/b' } }] },
          { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.test/c' } }] },
          { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.test/b' } }] },
        ],
      },
      {
        operation: 'propose',
        fieldGroup: 'facts',
        property: { id: 'schema:duration' },
        value: { type: 'value', content: { amount: '+12', unit: '1' } },
      },
      {
        operation: 'propose',
        fieldGroup: 'facts',
        property: { id: 'schema:datePublished' },
        value: { type: 'value', content: { time: '+2020-05-00T00:00:00Z', precision: 10, calendarmodel: 'http://www.wikidata.org/entity/Q1985727' } },
      },
    ],
    display: {
      normalized: { labels: { en: 'Lantern' }, aliases: { en: ['Lamp', 'Beacon'] } },
      mediaIntents: [{ kind: 'media-intent', role: 'cover', rightsHolder: 'A', license: 'CC-BY-SA-3.0', via: 'bangumi' }],
      sourceStatistic: { kind: 'source-statistic', source: 'vndb', count: 12, mean: 8, note: 'Source statistic only; not a local vote or publication.' },
    },
  });
  const diff = compareRetainedProjections(left, right);
  expect(diff.digestDiffers).toBe(true);
  expect(diff.converterDiffers).toBe(true);
  expect(diff.retainedEqual).toBe(false);
  const addresses = diff.parts.map((part) => part.address).join('\n');
  expect(addresses).toContain('target');
  expect(addresses).toContain('aliases');
  expect(addresses).toContain('statistic');
  expect(diff.parts.some((part) => part.domain === 'reference' && part.change !== 'unchanged')).toBe(true);
  expect(diff.parts.some((part) => /precision|time/.test(part.address) || JSON.stringify(part.before ?? {}).includes('precision'))).toBe(
    true,
  );
  expect(diff.parts.some((part) => part.domain === 'media')).toBe(false);
  expect(diff.parts.some((part) => part.domain === 'statistic')).toBe(true);
  expect(JSON.stringify(diff.parts)).toContain('not a local vote');

  const equalFields = compareRetainedProjections(left, { ...left, digest: 'c'.repeat(64), converterRevision: 'other' });
  expect(equalFields.retainedEqual).toBe(true);
  expect(equalFields.digestDiffers).toBe(true);
  expect(equalFields.parts.some((part) => part.address === 'retained-limit')).toBe(true);
});

test('four launch sources compare completed persistent plans without credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plan-compare-sources-'));
  try {
    const bangumiBytes = `${(await readFile(fixture('dumps/bangumi-subject.jsonlines'), 'utf8')).trim()}\n`;
    const rated = bangumiBytes.replace('"nsfw":false', '"score":8.2,"score_details":{"8":12},"rank":4,"nsfw":false');
    const cases = [
      ['bangumi', await dumpFile(directory, 'bangumi.jsonl', rated)],
      ['openlibrary', await dumpFile(directory, 'ol.tsv', await readFile(fixture('dumps/openlibrary.tsv')))],
      ['wikidata', await dumpFile(directory, 'wd.json', await readFile(fixture('dumps/wikidata.json')))],
      ['vndb', await dumpFile(directory, 'vndb.tar', archive())],
    ] as const;
    for (const [source, dump] of cases) {
      const left = await persistPreview(directory, `${source}-left`, { source, dump });
      const right = await persistPreview(directory, `${source}-right`, { source, dump });
      const comparison = await PlanComparison.build({ leftDir: left, rightDir: right, outputDir: join(directory, `${source}-cmp`) });
      try {
        expect(comparison.plan.complete, source).toBe(true);
        expect(comparison.plan.sourceKind, source).toBe(source);
        expect(comparison.plan.unchangedCount, source).toBeGreaterThan(0);
        expect(comparison.plan.converterDiffers, source).toBe(false);
        const first = comparison.page('unchanged', { limit: 1 });
        expect(first.rows).toHaveLength(1);
        const detail = comparison.record(first.rows[0]!.recordKey);
        expect(detail.found).toBe(true);
        if (source === 'bangumi' && detail.found) {
          expect(`${detail.leftJson}${detail.rightJson}`).not.toContain('"score"');
        }
      } finally {
        await comparison.close();
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('corrected input, converter pins, vanished distinction and baseline mismatch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plan-compare-refresh-'));
  try {
    const keys = ['Q1000', 'Q1001', 'Q1002'];
    const baselineA = join(directory, 'base-a.sqlite');
    const baselineB = join(directory, 'base-b.sqlite');
    await completedBaseline(baselineA, keys);
    await completedBaseline(baselineB, [...keys, 'Q1999']);
    const leftDump = await dumpFile(directory, 'left.json', wikidataItems(3));
    const rightDump = await dumpFile(directory, 'right.json', wikidataItems(4, (index) => (index === 0 ? 'Changed' : `Item ${index}`)));
    const left = await persistPreview(directory, 'left', { source: 'wikidata', dump: leftDump, baseline: baselineA });
    const right = await persistPreview(directory, 'right', { source: 'wikidata', dump: rightDump, baseline: baselineA });
    const comparison = await PlanComparison.build({ leftDir: left, rightDir: right });
    try {
      expect(comparison.plan.complete).toBe(true);
      expect(comparison.plan.onlyRightCount).toBe(1);
      expect(comparison.plan.changedCount).toBeGreaterThan(0);
      const added = comparison.page('only-right');
      expect(added.rows.map((row) => row.recordKey)).toEqual(['Q1003']);
      const changed = comparison.record('Q1000');
      expect(changed.found).toBe(true);
      if (changed.found) {
        expect(changed.kind).toBe('changed');
        expect(changed.rightVanished).toBe(false);
      }
      expect(comparison.store.explainKindPage()).toMatch(/SEARCH/i);
    } finally {
      await comparison.close();
    }

    const other = await persistPreview(directory, 'other-base', { source: 'wikidata', dump: rightDump, baseline: baselineB });
    await expect(PlanComparison.build({ leftDir: left, rightDir: other })).rejects.toThrow(/fresh common capture/);

    const aliased = await persistPreview(directory, 'alias', {
      source: 'wikidata',
      dump: leftDump,
      sourceAlias: 'catalogue-wikidata',
    });
    await expect(PlanComparison.build({ leftDir: left, rightDir: aliased })).rejects.toThrow(/different configured sources/);

    const copied = await persistPreview(directory, 'copied-plan', {
      source: 'wikidata',
      dump: leftDump,
      baseline: baselineA,
    });
    const db = new Database(join(copied, 'preview.sqlite'));
    db.query('UPDATE preview_plans SET converter_revision=?').run('wikidata-fixture');
    db.query('UPDATE preview_records SET converter_revision=?, digest=?').run('wikidata-fixture', 'c'.repeat(64));
    db.close();
    const revision = await PlanComparison.build({ leftDir: left, rightDir: copied });
    try {
      expect(revision.plan.converterDiffers).toBe(true);
      expect(revision.plan.changedCount).toBeGreaterThan(0);
      const row = revision.page('changed', { limit: 1 }).rows[0];
      expect(row?.converterDiffers).toBe(true);
      const detail = revision.record(row!.recordKey);
      expect(detail.found && detail.retainedEqual).toBe(true);
    } finally {
      await revision.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('cancellation leaves no completed marker and construction stays within record/page bounds', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plan-compare-cancel-'));
  try {
    const dump = await dumpFile(directory, 'items.json', wikidataItems(8));
    const left = await persistPreview(directory, 'left', { source: 'wikidata', dump });
    const right = await persistPreview(directory, 'right', { source: 'wikidata', dump });
    const controller = new AbortController();
    controller.abort();
    await expect(PlanComparison.build({ leftDir: left, rightDir: right, signal: controller.signal })).rejects.toThrow(
      'cancelled',
    );

    const output = join(directory, 'ceiling');
    const failed = await PlanComparison.build({ leftDir: left, rightDir: right, outputDir: output, maxStoreBytes: 64 });
    try {
      expect(failed.plan.complete).toBe(false);
      expect(failed.plan.errorIdentity).toBeTruthy();
    } finally {
      await failed.close();
    }
    await expect(PlanComparison.open(output)).rejects.toThrow(/incomplete/);

    const visits = { records: 0, parts: 0 };
    const comparison = await PlanComparison.build({
      leftDir: left,
      rightDir: right,
      observer: { onRecordVisit: () => visits.records++, onPartVisit: () => visits.parts++ },
    });
    try {
      expect(visits.records).toBe(8);
      const page = comparison.page('unchanged', { limit: 3 });
      expect(page.rows).toHaveLength(3);
      expect(page.end).toBe('more');
      if (page.end !== 'more') throw new Error('expected another comparison page');
      const next = comparison.page('unchanged', { limit: 3, cursor: page.nextCursor });
      expect(next.rows.length).toBeGreaterThan(0);
    } finally {
      await comparison.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('32/128/512 comparison growth keeps pages indexed and admission exact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plan-compare-growth-'));
  const check: CountedCheck = {
    read: (value) => value as { 'sqlite statements': number; 'sqlite returned rows': number },
    bounds: { 'sqlite statements': 'constant', 'sqlite returned rows': 'constant' },
    slack: {
      'sqlite statements': { absolute: 2, relative: 0.15 },
      'sqlite returned rows': { absolute: 2, relative: 0.15 },
    },
  };
  const pages: { scale: number; counted: ReturnType<typeof countedSample> }[] = [];
  try {
    for (const scale of [32, 128, 512]) {
      const leftDump = await dumpFile(
        directory,
        `left-${scale}.json`,
        wikidataItems(scale, (index) => (index === 0 ? 'Left' : `Item ${index}`)),
      );
      const rightDump = await dumpFile(
        directory,
        `right-${scale}.json`,
        wikidataItems(scale + 1, (index) => (index === 0 ? 'Right' : `Item ${index}`)),
      );
      const left = await persistPreview(directory, `left-${scale}`, { source: 'wikidata', dump: leftDump });
      const right = await persistPreview(directory, `right-${scale}`, { source: 'wikidata', dump: rightDump });
      const visits = { records: 0, parts: 0 };
      const output = join(directory, `cmp-${scale}`);
      const built = await PlanComparison.build({
        leftDir: left,
        rightDir: right,
        outputDir: output,
        observer: { onRecordVisit: () => visits.records++, onPartVisit: () => visits.parts++ },
      });
      expect(visits.records).toBe(scale + 1);
      expect(built.plan.onlyRightCount).toBe(1);
      expect(built.plan.changedCount).toBeGreaterThan(0);
      await built.close();

      const database = new Database(join(output, 'comparison.sqlite'));
      database.exec('CREATE TABLE IF NOT EXISTS unrelated_history (id INTEGER PRIMARY KEY, payload TEXT)');
      const insert = database.query('INSERT INTO unrelated_history(payload) VALUES (?)');
      for (let index = 0; index < scale * 4; index++) insert.run(`history-${index}`);
      const probe = createSqliteProbe(database, { growingTables: [...COMPARISON_TABLES, 'unrelated_history'] });
      const store = new PlanComparisonStore(probe.database);
      try {
        const plan = store.loadPlan();
        expect(plan?.complete).toBe(true);
        const measured = probe.measure(() => store.pageRecords(plan!.comparisonId, 'changed', { limit: 20 }));
        expect(measured.value.rows.length).toBeGreaterThan(0);
        expect(measured.value.rows.length).toBeLessThanOrEqual(20);
        pages.push({ scale, counted: countedSample([measured.counts]) });
        const detail = probe.measure(() => store.recordDetail(plan!.comparisonId, 'Q1000'));
        expect(detail.value.found).toBe(true);
      } finally {
        store.close();
      }
    }
    expect(countedViolations(check, pages)).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
