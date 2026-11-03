import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DumpPreview } from '../src/dump-preview.ts';
import { RecordStore } from '../src/record-store.ts';
import { RunStore, type SourceProjection } from '../src/run-store.ts';

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
    put(
      148,
      `${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `,
    );
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

async function completedBaseline(path: string, keys: string[], converter = 'wikidata@1') {
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
        converter_revision: converter,
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

test('four launch sources decode real dumps without credentials or native effects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dump-preview-sources-'));
  try {
    const vndb = await dumpFile(directory, 'vndb.tar', archive());
    const cases = [
      ['bangumi', await dumpFile(directory, 'bangumi.jsonl', await readFile(fixture('dumps/bangumi-subject.jsonlines')))],
      ['openlibrary', await dumpFile(directory, 'ol.tsv', await readFile(fixture('dumps/openlibrary.tsv')))],
      ['wikidata', await dumpFile(directory, 'wd.json', await readFile(fixture('dumps/wikidata.json')))],
      ['vndb', vndb],
    ] as const;
    for (const [source, dump] of cases) {
      const preview = await DumpPreview.build({ source, dump });
      try {
        expect(preview.plan.complete, source).toBe(true);
        expect(preview.plan.viewKind).toBe('first-import');
        expect(preview.plan.admitted).toBeGreaterThan(0);
        expect(preview.plan.vanishedCount).toBe(0);
        expect(preview.plan.sourceKind).toBe(source);
      } finally {
        await preview.close();
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('baseline comparison pages changed and vanished keys and withholds vanished on incomplete input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dump-preview-compare-'));
  try {
    const baseline = join(directory, 'state.sqlite');
    const keys = Array.from({ length: 22 }, (_, index) => `Q${1000 + index}`);
    await completedBaseline(baseline, [...keys, 'Q1999']);
    const dump = await dumpFile(
      directory,
      'next.json',
      wikidataItems(22, (index) => (index === 0 ? 'Changed title \u202ehostile' : `Item ${index}`)),
    );
    const preview = await DumpPreview.build({ source: 'wikidata', dump, baseline });
    try {
      expect(preview.plan.complete).toBe(true);
      expect(preview.plan.viewKind).toBe('baseline-comparison');
      expect(preview.plan.prior).toBe(23);
      expect(preview.plan.vanishedCount).toBe(1);
      expect(preview.plan.changedCount + preview.plan.newCount + preview.plan.unchangedCount).toBe(22);
      const vanished = preview.page('vanished', { limit: 20 });
      expect(vanished.rows.map((row) => row.recordKey)).toEqual(['Q1999']);
      expect(vanished.end).toBe('end');
      const changed = preview.page('changed', { limit: 20 });
      expect(changed.rows.length).toBeGreaterThan(0);
      const first = preview.page('new', { limit: 20 });
      const next = first.end === 'more' ? preview.page('new', { limit: 20, cursor: first.nextCursor }) : first;
      expect(next.rows.length).toBeLessThanOrEqual(20);
      const detail = preview.record(keys[0]!);
      expect(detail.found).toBe(true);
      if (detail.found && detail.kind !== 'vanished') {
        expect(detail.displayJson).not.toContain('\u202e');
        expect(detail.provenanceJson).toContain(keys[0]!);
      }
      expect(preview.store.explainKindPage()).toMatch(/SEARCH/i);
    } finally {
      await preview.close();
    }

    const broken = await dumpFile(directory, 'broken.json', '[\n{"type":"item","id":"Q1"\n');
    const incomplete = await DumpPreview.build({ source: 'wikidata', dump: broken, baseline });
    try {
      expect(incomplete.plan.complete).toBe(false);
      expect(incomplete.plan.errorIdentity).toBe('invalid-input');
      expect(() => incomplete.page('vanished')).toThrow('vanished membership');
    } finally {
      await incomplete.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('source alias isolation, converter revision change, cancellation and Open Library keys', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dump-preview-alias-'));
  try {
    const records = new RecordStore(join(directory, 'records.sqlite'));
    records.put({
      source: 'openlibrary',
      recordKey: '/works/OL1W',
      recordRevision: '7',
      digest: 'a'.repeat(64),
      converter_revision: 'open-library@1',
      state: 'present',
    });
    expect(records.get('openlibrary', '/works/OL1W')?.recordKey).toBe('/works/OL1W');
    records.close();

    const baseline = join(directory, 'state.sqlite');
    await completedBaseline(baseline, ['Q1000'], 'old@1');
    const dump = await dumpFile(directory, 'one.json', wikidataItems(1));
    const aliased = await DumpPreview.build({
      source: 'wikidata',
      dump,
      sourceAlias: 'catalogue-wikidata',
      baseline,
    });
    try {
      expect(aliased.plan.source).toBe('catalogue-wikidata');
      expect(aliased.plan.viewKind).toBe('first-import');
      expect(aliased.plan.newCount).toBe(1);
    } finally {
      await aliased.close();
    }
    const changedRevision = await DumpPreview.build({ source: 'wikidata', dump, baseline });
    try {
      expect(changedRevision.plan.changedCount).toBe(1);
      expect(changedRevision.plan.converterRevision).not.toBe('old@1');
    } finally {
      await changedRevision.close();
    }

    const controller = new AbortController();
    controller.abort();
    await expect(DumpPreview.build({ source: 'wikidata', dump, signal: controller.signal })).rejects.toThrow(
      'cancelled',
    );

    const empty = join(directory, 'empty.sqlite');
    const emptyDb = new Database(empty, { create: true, strict: true });
    emptyDb.close();
    await expect(DumpPreview.build({ source: 'wikidata', dump, baseline: empty })).rejects.toThrow(
      /Unsupported importer state schema/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
