import { describe, expect, test } from 'bun:test';
import { datasetCoverage, DATASET_NATIVE_MAPPERS } from '../../../scripts/datasets/native/coverage.ts';
import { datasetRecordDigest, datasetSourceIdentity, datasetSourceReference } from '../../../scripts/datasets/native/context.ts';
import { testDatasetImportCoverage } from '../../../scripts/datasets/conformance.ts';
import type { DatasetCoverageKey, DatasetMappingReceipt, DatasetRecord, DatasetSnapshot } from '../../../scripts/datasets/types.ts';

const target = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const record: DatasetRecord = {
  key: 'vndb:vn:v11', provider: 'vndb', kind: 'vn', externalId: 'v11',
  title: 'Fate/stay night', language: 'ja', sourceUrl: 'https://vndb.org/v11', native: 'work',
  data: { aliases: ['フェイト'], length: 0, official: false, description: null,
    empty: '', list: [], object: {}, 'a/b~c': { value: 2 } },
};
const edge = { from: record.key, to: record.key, kind: 'relation', data: { spoiler: 0, relation: 'alternative' } };
const snapshot: DatasetSnapshot = {
  format: 'rezics-local-dataset-v1', id: 'captured-shape', digest: 'a'.repeat(64), createdAt: '2026-10-19',
  captures: [], images: [{ record: record.key, role: 'portrait', url: 'https://example.org/image.jpg',
    capture: null, missing: false, unavailable: { status: 503 } }],
  sources: [{ provider: 'vndb', roots: [record.key], records: [record], edges: [edge, structuredClone(edge)],
    images: [], scope: { complete: true } }],
};
const selected = new Set([record.key]);
const key = (path: string): DatasetCoverageKey => ({ record: record.key, kind: 'field', path });
const mapping = (receipt = 'one'): DatasetMappingReceipt => ({ target,
  readPath: '/v1/works/00000000-0000-4000-8000-000000000001/metadata', receipt: { receipt } });

describe('observed dataset adoption coverage', () => {
  test('snapshot hashes qualify evidence without changing provider-qualified source identity', () => {
    const changed = { ...record, data: { title: 'later source revision' } };
    expect(datasetSourceIdentity(changed)).toBe(datasetSourceIdentity(record));
    expect(datasetRecordDigest(changed)).not.toBe(datasetRecordDigest(record));
    expect(datasetSourceIdentity({ ...record, provider: 'bangumi' })).not.toBe(datasetSourceIdentity(record));
    expect(datasetSourceIdentity({ ...record, kind: 'release' })).not.toBe(datasetSourceIdentity(record));
    const source = datasetSourceReference(snapshot, record, ['first-part', 'second-part']);
    expect(source.observations).toEqual(['first-part', 'second-part']);
    expect(source.recordDigest).toBe(datasetRecordDigest(record));
    expect(source.snapshotDigest).toBe(snapshot.digest);
  });

  test('inventories exact field, repeated edge and image occurrences without converting zero/false/failure into absence', () => {
    const inventory = datasetCoverage(snapshot, selected);
    const report = inventory.report(true, new Set());
    const at = (path: string) => report.entries.find(entry => entry.path === path)!;
    for (const path of ['/data/length', '/data/official']) {
      expect(at(path).observation).toBe('present');
      expect(at(path).disposition.status).toBe('unmapped');
    }
    for (const path of ['/data/description', '/data/empty', '/data/list', '/data/object']) {
      expect(at(path).observation).toBe('empty');
      expect(at(path).disposition.status).toBe('absent');
    }
    expect(at('/data/a~1b~0c/value').observation).toBe('present');
    const relations = report.entries.filter(entry => entry.kind === 'edge');
    expect(relations).toHaveLength(2);
    expect(relations[0]!.path).not.toBe(relations[1]!.path);
    expect(relations[0]!.valueDigest).toBe(relations[1]!.valueDigest);
    expect(at('/images/0').observation).toBe('unavailable');
    expect(at('/images/0').disposition).toEqual({ status: 'unmapped', reason: 'acquisition-failed' });
    expect(report.transportCompleted).toBe(true);
    expect(report.catalogueReady).toBe(false);
    expect(report.pendingMappers).toEqual(DATASET_NATIVE_MAPPERS);
    testDatasetImportCoverage(snapshot, report);
  });

  test('requires retained evidence, positive native receipts and exact target grain', () => {
    const inventory = datasetCoverage(snapshot, selected);
    expect(() => inventory.disposition(key('/data/official'), { status: 'absent', reason: 'empty' })).toThrow('not absent');
    expect(() => inventory.disposition(key('/title'), { status: 'source-only', reason: 'retained' })).toThrow('retained source');
    expect(() => inventory.disposition(key('/title'), { status: 'mapped', reason: 'attempted', mapping: {
      ...mapping(), receipt: {},
    } })).toThrow('exact native receipt');
    expect(() => inventory.disposition(key('/title'), { status: 'mapped', reason: 'raw-source', mapping: {
      ...mapping(), readPath: '/v1/sources/conversions/example',
    } })).toThrow('consuming read');
    inventory.retain(record.key);
    inventory.disposition(key('/title'), { status: 'mapped', reason: 'adopted', mapping: mapping() });
    inventory.disposition(key('/title'), { status: 'mapped', reason: 'new-qualified-support', mapping: mapping('two') });
    const report = inventory.report(true, new Set(DATASET_NATIVE_MAPPERS));
    const title = report.entries.find(entry => entry.path === '/title')!;
    expect(title.mappings?.map(value => value.receipt)).toEqual([{ receipt: 'one' }, { receipt: 'two' }]);
    expect(() => inventory.disposition(key('/title'), { status: 'mapped', reason: 'other-grain', mapping: {
      ...mapping(), target: target.slice(0, -1) + '2',
    } })).toThrow('cannot be replaced');
    expect(() => inventory.disposition({ ...key('/images/0'), kind: 'image' }, {
      status: 'mapped', reason: 'placeholder', mapping: mapping(),
    })).toThrow('Unavailable source');
    testDatasetImportCoverage(snapshot, report);
  });

  test('never-acquired candidates retain source pointers and prevent completeness even when retained source-only', () => {
    const available = structuredClone(snapshot);
    available.images = [];
    available.sources[0]!.images = [{ record: record.key, role: 'portrait', url: 'https://example.org/not-captured.jpg' }];
    const inventory = datasetCoverage(available, selected);
    inventory.retain(record.key);
    const candidate: DatasetCoverageKey = { record: record.key, kind: 'source-image', path: '/sources/0/images/0' };
    expect(() => inventory.disposition(candidate, { status: 'mapped', reason: 'guessed-media', mapping: mapping() }))
      .toThrow('Unavailable source evidence');
    for (const entry of inventory.entries.values()) if (entry.observation === 'present')
      inventory.disposition(entry, { status: 'source-only', reason: 'retained-evidence' });
    inventory.disposition(key('/title'), { status: 'mapped', reason: 'native-user-fact', mapping: mapping() });
    const report = inventory.report(true, new Set(DATASET_NATIVE_MAPPERS));
    expect(report.counts.unmapped).toBe(0);
    expect(report.rootsWithoutNativeFacts).toEqual([]);
    expect(report.pendingAcquisitions).toEqual([candidate]);
    expect(report.catalogueReady).toBe(false);
    expect(report.entries.filter(entry => entry.kind === 'image')).toEqual([]);
    const sourceImage = report.entries.find(entry => entry.kind === 'source-image')!;
    expect(sourceImage.observation).toBe('present');
    expect(sourceImage.acquisition).toBe('not-acquired');
    expect(sourceImage.valueDigest).toMatch(/^[a-f0-9]{64}$/);
    testDatasetImportCoverage(available, report);
    const changed = structuredClone(report);
    changed.entries.find(entry => entry.kind === 'source-image')!.acquisition = 'captured';
    expect(() => testDatasetImportCoverage(available, changed)).toThrow('acquisition evidence');
  });

  test('all source-only dispositions and completed transport never substitute for a native user fact', () => {
    const available = structuredClone(snapshot);
    available.images = [];
    const inventory = datasetCoverage(available, selected);
    inventory.retain(record.key);
    for (const entry of inventory.entries.values()) if (entry.observation === 'present')
      inventory.disposition(entry, { status: 'source-only', reason: 'retained-for-reviewed-adoption' });
    let report = inventory.report(true, new Set(DATASET_NATIVE_MAPPERS));
    expect(report.counts.unmapped).toBe(0);
    expect(report.rootsWithoutNativeFacts).toEqual([record.key]);
    expect(report.catalogueReady).toBe(false);
    inventory.disposition(key('/title'), { status: 'mapped', reason: 'adopted', mapping: mapping() });
    report = inventory.report(true, new Set(DATASET_NATIVE_MAPPERS));
    expect(report.catalogueReady).toBe(true);
    testDatasetImportCoverage(available, report);
    const omitted = structuredClone(report);
    omitted.entries.pop();
    expect(() => testDatasetImportCoverage(available, omitted)).toThrow('omits');
    const invented = structuredClone(report);
    invented.entries[0]!.valueDigest = 'b'.repeat(64);
    expect(() => testDatasetImportCoverage(available, invented)).toThrow('source evidence');
    const falseReady = structuredClone(report);
    falseReady.transportCompleted = false;
    expect(() => testDatasetImportCoverage(available, falseReady)).toThrow('readiness');
  });
});
