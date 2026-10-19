import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  importDataset,
  intakeChunks,
  reconstructIntake,
  semanticBatches,
  projectionLanguage,
  nativeBatchSize,
  assertNoImportedUserPosts,
  DatasetSelectionRefusedError,
} from '../../../scripts/datasets/import.ts';
import { localDatasetSession, type DatasetApi } from '../../../scripts/datasets/auth.ts';
import { putBlob, repository, sha256 } from '../../../scripts/datasets/store.ts';
import { datasetStackMarker } from '../../../scripts/datasets/bootstrap.ts';
import { acquireDatasetImportLock, datasetImportLockPath } from '../../../scripts/datasets/lock.ts';
import type { DatasetCoverEvidence, DatasetEdge, DatasetRecord, DatasetSnapshot, StoredImage } from '../../../scripts/datasets/types.ts';
import type { DatasetSelectionOptions } from '../../../scripts/datasets/selection.ts';

const roots: string[] = [];
const root = () => {
  const directory = resolve('.temp/dataset-import-tests', crypto.randomUUID());
  mkdirSync(directory, { recursive: true });
  roots.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const iri = (value: number) =>
  `https://rezics.com/id/00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const uuid = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const record = (key: string, native: DatasetRecord['native'] = 'source-only'): DatasetRecord => ({
  key,
  provider: 'vndb',
  kind: 'vn',
  externalId: key,
  title: `${key}\n[Title]`,
  language: 'ja',
  sourceUrl: 'https://vndb.org/v11',
  native,
  data: { nested: { empty: null }, flags: ['x', 'y'] },
});
const snapshot = (records: DatasetRecord[]): DatasetSnapshot => ({
  format: 'rezics-local-dataset-v1',
  id: 'test-snapshot',
  digest: 'a'.repeat(64),
  createdAt: '2026-10-02T00:00:00Z',
  sources: [
    {
      provider: 'vndb',
      roots: [records[0]?.key ?? ''],
      records,
      edges:
        records.length > 1
          ? [
              {
                from: records[0]!.key,
                to: records[1]!.key,
                kind: 'character',
                data: { spoiler: 2, order: 1 },
              },
            ]
          : [],
      images: [],
      scope: { complete: true },
    },
  ],
  images: [],
  captures: [],
});

test('platform imports refuse source user posts before retaining or publishing a snapshot', () => {
  expect(() => assertNoImportedUserPosts([{ ...record('review'), kind: 'review' }])).toThrow('source user posts');
  expect(() => assertNoImportedUserPosts([{ ...record('subject'), provider: 'bangumi',
    data: { nested: [{ comments: ['private user expression'] }] } }])).toThrow('source user posts');
  expect(() => assertNoImportedUserPosts([{ ...record('subject'), provider: 'bangumi',
    data: { summary: 'Licensed wiki summary', infobox: 'Factual wiki fields' } }])).not.toThrow();
});
function apiFixture(options: { loseCoverReplies?: ('reserve' | 'transfer' | 'selection')[];
  editorBeforeSelection?: boolean } = {}) {
  const requests: { path: string; key?: string; body: unknown }[] = [],
    transfers: { path: string; digest: string; bytes: Buffer }[] = [],
    receipts = new Map<string, Record<string, unknown>>(),
    selectionReceipts = new Map<string, { status: number; body: Record<string, unknown> }>(),
    uploads = new Map<string, { asset: string; digest: string; byteLength: number; activated?: Record<string, unknown> }>(),
    currentSelections = new Map<string, string | null>(),
    nativeWorks: string[] = [];
  let id = 1,
    lost = false,
    loseAfterCommit = false,
    lostCoverReplies = new Set<string>(),
    coverRefusal: { status: number; code: string; type: string } | null = null,
    editorBeforeSelection = options.editorBeforeSelection ?? false;
  const api: DatasetApi = {
    wait: async () => {},
    async request(_method, path, body, key) {
      requests.push({ path, body, key });
      if (path === '/v1/catalogue/candidates')
        return {
          status: 200,
          body: {
            candidateReceipt: '00000000-0000-4000-8000-999999999999',
            sourcePosition: { dataEpoch: 'epoch-1' },
            candidates: [],
          },
        };
      if (path.startsWith('/v1/resources/') && path.includes('?actingSubject=')) {
        const target = `https://rezics.com/id/${path.split('/')[3]?.split('?')[0]}`;
        const selection = currentSelections.get(target) ?? null;
        return { status: 200, body: { profile: 'resource-summary-v1', status: 'available',
          type: 'work', avatar: selection ? { kind: 'image', selection } : { kind: 'fallback' } } };
      }
      if (path === '/v1/media/uploads') {
        const uploadBody = body as { sha256: string; byteLength: number; importedCover?: unknown };
        if (coverRefusal && uploadBody.importedCover)
          return { status: coverRefusal.status, body: { type: coverRefusal.type,
            status: coverRefusal.status, code: coverRefusal.code } };
        if (!key) throw new Error('Every product mutation requires an idempotency key');
        if (receipts.has(key)) return { status: 200, body: receipts.get(key)! };
        const asset = uuid(7000 + id++), upload = uuid(7000 + id++);
        const receipt = { asset, upload, uploadUrl: `/v1/media/uploads/${upload}/bytes`, stateHead: uuid(7100) };
        uploads.set(upload, { asset, digest: uploadBody.sha256, byteLength: uploadBody.byteLength });
        receipts.set(key, receipt);
        if (loseCoverReply('reserve')) throw new Error('closed socket after reserve commit');
        return { status: 201, body: receipt };
      }
      if (path.startsWith('/v1/resources/') && path.endsWith('/avatar')) {
        if (!key) throw new Error('Every product mutation requires an idempotency key');
        const saved = selectionReceipts.get(key);
        if (saved) return { status: saved.status === 409 ? 409 : 200, body: saved.body };
        const target = `https://rezics.com/id/${path.split('/')[3]}`;
        if (editorBeforeSelection) {
          currentSelections.set(target, uuid(7999));
          editorBeforeSelection = false;
        }
        const selectionBody = body as { expectedSelection: string | null; asset: string };
        const current = currentSelections.get(target) ?? null;
        if (selectionBody.expectedSelection !== current) {
          const stale = { status: 409, body: { code: 'stale_head', current } };
          selectionReceipts.set(key, stale);
          return stale;
        }
        const selection = uuid(7200 + id++);
        currentSelections.set(target, selection);
        const result = { status: 201, body: { target, selection, predecessor: current, replayed: false } };
        selectionReceipts.set(key, result);
        if (loseCoverReply('selection')) throw new Error('closed socket after selection commit');
        return result;
      }
      if (!key) throw new Error('Every product mutation requires an idempotency key');
      if (receipts.has(key)) return { status: 200, body: receipts.get(key)! };
      let receipt: Record<string, unknown>;
      if (path === '/v1/sources/intakes') {
        const intake = body as { rawBytesBase64?: string };
        const bytes = intake.rawBytesBase64 ? Buffer.from(intake.rawBytesBase64, 'base64') : Buffer.alloc(0);
        receipt = { observation: { observation: iri(id++), record: iri(id++), byteDigest: sha256(bytes) }, replayed: false };
      }
      else if (path === '/v1/works') {
        expect(body).not.toHaveProperty('authoring');
        expect(body).toHaveProperty('candidateReceipt');
        receipt = {
          work: iri(id++),
          mainVersion: iri(id++),
          workRevision: iri(id++),
          mainRevision: iri(id++),
        };
      } else if (path === '/v1/work-imports/bulk') {
        const items = (body as { items: { key: string; input: unknown }[] }).items;
        receipt = { complete: true, partial: false, items: items.map(item => {
          const work = iri(id++);
          nativeWorks.push(work);
          return { key: item.key, status: 'succeeded', receipt: { outcome: 'succeeded', work,
            mainVersion: iri(id++), workRevision: iri(id++), mainRevision: iri(id++) } };
        }) };
      } else if (path === '/v1/rights/use-assessments') {
        receipt = { assessmentId: uuid(id++), obligations: (body as { obligations: unknown[] }).obligations };
      } else if (path === '/v1/semantic/changes/bulk') {
        expect(body).not.toHaveProperty('target');
        const states = (body as { items: { properties: unknown[] }[] }).items;
        receipt = {
          items: states.map(() => ({ component: iri(id++), revision: iri(id++) })),
          receipt: iri(id++),
        };
      } else throw new Error(`Unexpected public route ${path}`);
      receipts.set(key, receipt);
      if (loseAfterCommit && !lost) {
        lost = true;
        throw new Error('closed socket after commit');
      }
      return { status: 201, body: receipt };
    },
    async transfer(path, bytes) {
      const upload = path.match(/^\/v1\/media\/uploads\/([0-9a-f-]{36})\/bytes$/)?.[1];
      if (!upload || !uploads.has(upload)) return { status: 404, body: { code: 'upload_missing' } };
      const current = uploads.get(upload)!;
      const pinned = Buffer.from(bytes);
      transfers.push({ path, digest: sha256(pinned), bytes: pinned });
      expect(pinned.byteLength).toBe(current.byteLength);
      expect(sha256(pinned)).toBe(current.digest);
      if (current.activated) return { status: 200, body: { ...current.activated, replayed: true } };
      const activated = { asset: current.asset, upload, status: 'activated', clearance: 'cleared',
        representation: uuid(7300 + id++), revision: uuid(7400 + id++), replayed: false };
      current.activated = activated;
      if (loseCoverReply('transfer')) throw new Error('closed socket after transfer commit');
      return { status: 201, body: activated };
    },
  };
  function loseCoverReply(step: 'reserve' | 'transfer' | 'selection'): boolean {
    if (!options.loseCoverReplies?.includes(step) || lostCoverReplies.has(step)) return false;
    lostCoverReplies.add(step);
    return true;
  }
  return {
    api,
    requests,
    transfers,
    receipts,
    uploads,
    selectionReceipts,
    currentSelections,
    nativeWorks,
    loseNextResponse: () => {
      loseAfterCommit = true;
    },
    useStaleSelection: () => { editorBeforeSelection = true; },
    denyCovers: () => { coverRefusal = { status: 403, code: 'media_denied',
      type: 'https://rezics.com/problems/authority_denied' }; },
    suppressCovers: () => { coverRefusal = { status: 403, code: 'source_cover_suppressed',
      type: 'https://rezics.com/problems/source_cover_suppressed' }; },
    makeCoversUnavailable: () => { coverRefusal = { status: 503, code: 'media_unavailable',
      type: 'https://rezics.com/problems/media_unavailable' }; },
  };
}

function coverSnapshot(directory: string, sourceRecord: DatasetRecord, source?: Partial<DatasetCoverEvidence>) {
  const bytes = Buffer.from('pinned dataset cover bytes\u0000with exact digest');
  const imageUrl = 'https://images.example.test/covers/pinned.png';
  const sourceProvider = source?.provider ?? sourceRecord.provider;
  const sourceNamespace = source?.namespace ?? 'subject';
  const sourceExternalId = source?.externalId ?? `canonical-${sourceRecord.externalId}`;
  const sourceCaptureUrl = source?.captureUrl
    ?? `https://records.example.test/${sourceProvider}/${sourceNamespace}/${encodeURIComponent(sourceExternalId)}`;
  const recordBytes = Buffer.from(JSON.stringify({ id: sourceExternalId, images: { common: imageUrl } }));
  const recordDigest = putBlob(directory, recordBytes);
  const evidence: DatasetCoverEvidence = {
    provider: sourceRecord.provider,
    namespace: 'subject',
    externalId: `canonical-${sourceRecord.externalId}`,
    revision: null,
    captureUrl: sourceCaptureUrl,
    recordDigest,
    field: '/images/common',
    sourceName: 'Reviewed source',
    sourceUrl: `https://catalogue.example.test/record/${sourceRecord.externalId}`,
    holder: null,
    ...source,
  };
  const image: StoredImage = {
    record: sourceRecord.key,
    role: 'cover',
    url: imageUrl,
    sourceEvidence: evidence,
    captureRole: 'cover',
    capture: { url: imageUrl, digest: putBlob(directory, bytes), bytes: bytes.length,
      mediaType: 'image/png', fetchedAt: '2026-10-02T00:00:00Z', etag: null, lastModified: null },
    missing: false,
  };
  const value = snapshot([sourceRecord]);
  value.captures = [{ url: evidence.captureUrl, digest: evidence.recordDigest,
    bytes: recordBytes.length, mediaType: 'application/json', fetchedAt: '2026-10-02T00:00:00Z',
    etag: null, lastModified: null }];
  value.images = [image];
  value.sources[0]!.images = [image];
  return { snapshot: value, bytes, image, evidence };
}

const options = (api: DatasetApi) => ({
  api,
  actingSubject: iri(9000),
  mainOrigin: 'http://127.0.0.1:3001',
  webOrigin: 'http://127.0.0.1:3000',
});

describe('root selection through the public-API importer', () => {
  const selection = (key: string): DatasetSelectionOptions => ({
    roots: [key],
    budget: { maxInputItems: 100, maxRecords: 20, maxEdges: 20, maxImages: 20,
      maxJsonBytes: 100_000, maxMediaBytes: 100_000 },
  });
  function parent() {
    const records = [record('vndb:vn:v99', 'work'), record('vndb:staff:s99', 'person'),
      record('vndb:vn:v11', 'work'), record('vndb:character:c1', 'character'),
      record('vndb:trait:i1', 'concept'), record('vndb:vn:v12', 'work'),
      record('vndb:staff:s12', 'person')];
    for (const item of records) {
      const [, kind, externalId] = item.key.split(':');
      item.kind = kind!;
      item.externalId = externalId!;
    }
    const value = snapshot(records), source = value.sources[0]!;
    source.roots = [records[0]!.key, records[2]!.key];
    source.edges = [
      { from: records[0]!.key, to: records[1]!.key, kind: 'staff:scenario', data: { order: 0 } },
      { from: records[3]!.key, to: records[2]!.key, kind: 'appearance', data: { order: 7, spoiler: 2 } },
      { from: records[3]!.key, to: records[2]!.key, kind: 'appearance', data: { order: 7, spoiler: 2 } },
      { from: records[3]!.key, to: records[4]!.key, kind: 'trait', data: { spoiler: 1 } },
      { from: records[2]!.key, to: records[5]!.key, kind: 'vn:prequel', data: { official: true } },
      { from: records[5]!.key, to: records[6]!.key, kind: 'staff:scenario', data: { order: 9 } },
      { from: records[3]!.key, to: records[0]!.key, kind: 'appearance', data: { otherWork: true } },
    ];
    const image = (record: string, role: string, url: string): StoredImage => ({
      record, role, url, captureRole: 'other', capture: null, missing: true,
    });
    value.images = [image(records[0]!.key, 'cover', 'https://images.example.test/other.png'),
      image(records[2]!.key, 'gallery', 'https://images.example.test/gallery.png'),
      image(records[2]!.key, 'cover', 'https://images.example.test/cover.png'),
      image(records[2]!.key, 'cover', 'https://images.example.test/cover.png')];
    source.images = [...value.images, { record: records[2]!.key, role: 'candidate',
      url: 'https://images.example.test/never-acquired.png' }];
    return value;
  }
  function recordIntakes(fixture: ReturnType<typeof apiFixture>) {
    return fixture.requests.filter(call => call.path === '/v1/sources/intakes').map(call => {
      const body = call.body as { rawBytesBase64: string; sourceRevision: string };
      const envelope = JSON.parse(Buffer.from(body.rawBytesBase64, 'base64').toString()) as {
        format: string; snapshot: string; digest: string; record: DatasetRecord;
        edges: DatasetEdge[]; images: StoredImage[];
      };
      return { ...call, body, envelope };
    }).filter(call => call.envelope.format === 'rezics-dataset-record-v1');
  }

  for (const reason of ['budget-exceeded', 'missing-root'] as const) {
    test(`${reason} refuses the entire selection before catalogue reads or writes`, async () => {
      const directory = root(), fixture = apiFixture(), source = parent();
      const requested = selection(source.sources[0]!.records[2]!.key);
      if (reason === 'budget-exceeded') requested.budget.maxRecords = 1;
      else requested.roots = ['vndb:vn:missing'];
      let failure: unknown;
      try {
        await importDataset(directory, source, { ...options(fixture.api), selection: requested });
      } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(DatasetSelectionRefusedError);
      if (!(failure instanceof DatasetSelectionRefusedError)) throw failure;
      expect(failure.manifest.limitations.some(limit => limit.code === reason)).toBe(true);
      expect(failure.manifest.parent).toEqual({ id: source.id, digest: source.digest });
      expect(JSON.parse(readFileSync(failure.selectionFile, 'utf8'))).toEqual(failure.manifest);
      expect(fixture.requests).toEqual([]);
      expect(fixture.transfers).toEqual([]);
      expect(existsSync(join(directory, 'import-latest.json'))).toBe(false);
      expect(readdirSync(join(directory, 'imports'))).toEqual(['selections']);
    });
  }

  test('retains the full accepted closure without recapping, including original occurrence coordinates', async () => {
    const directory = root(), fixture = apiFixture(), source = parent();
    const bytes = JSON.stringify(source), frozenFile = join(directory, 'frozen-parent.json');
    writeFileSync(frozenFile, bytes);
    const freeze = (value: unknown): void => {
      if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
      }
    };
    freeze(source);
    const result = await importDataset(directory, source, { ...options(fixture.api), native: false,
      maxRecords: 1, selection: selection(source.sources[0]!.records[2]!.key) });
    const sourceRecords = source.sources[0]!.records;
    expect(result.records).toBe(4);
    expect(result.completed).toBe(true);
    const intakes = recordIntakes(fixture);
    expect(intakes.map(call => call.envelope.record.key)).toEqual(sourceRecords.slice(2, 6).map(record => record.key));
    for (const { envelope, body } of intakes) {
      expect(envelope).toEqual({ format: 'rezics-dataset-record-v1', snapshot: source.id,
        digest: source.digest, record: sourceRecords.find(record => record.key === envelope.record.key),
        edges: source.sources[0]!.edges.filter(edge => edge.from === envelope.record.key),
        images: source.images.filter(image => image.record === envelope.record.key) });
      expect(body.sourceRevision).toBe(source.digest);
    }
    expect(result.selection?.sources[0]).toMatchObject({ source: 0, scope: source.sources[0]!.scope,
      records: [2, 3, 4, 5], edges: [1, 2, 3, 4], images: [1, 2, 3, 4] });
    expect(result.selection?.storedImages).toEqual([1, 2, 3]);
    expect(result.selection?.parent).toEqual({ id: source.id, digest: source.digest });
    expect(result.selection?.coverage).toEqual({ knowledge: 'complete', media: 'incomplete' });
    expect(JSON.parse(readFileSync(result.selectionFile!, 'utf8'))).toEqual(result.selection);
    expect(JSON.parse(readFileSync(join(directory, 'import-latest.json'), 'utf8')).selectionFile).toBe(result.selectionFile);
    expect(JSON.stringify(source)).toBe(bytes);
    expect(readFileSync(frozenFile, 'utf8')).toBe(bytes);
    expect(fixture.transfers).toEqual([]);
    expect(result.coverResults).toEqual([]);
  });

  test('preserves prior native bindings and receipts across selection, replay and related Work expansion', async () => {
    const directory = root(), fixture = apiFixture(), source = parent();
    const prior = await importDataset(directory, source, { ...options(fixture.api), maxRecords: 1 });
    const original = JSON.parse(readFileSync(prior.receiptFile, 'utf8'));
    const requested = selection(source.sources[0]!.records[2]!.key);
    const accepted = await importDataset(directory, source, { ...options(fixture.api),
      selection: requested, maxRecords: 1 });
    const journal = JSON.parse(readFileSync(accepted.receiptFile, 'utf8'));
    expect(accepted.receiptFile).toBe(prior.receiptFile);
    expect(accepted.records).toBe(4);
    expect(accepted.nativeRecords).toBe(5);
    for (const [key, native] of Object.entries(original.native)) expect(journal.native[key]).toEqual(native);
    for (const [key, entry] of Object.entries(original.entries)) expect(journal.entries[key]).toEqual(entry);
    const character = source.sources[0]!.records[3]!;
    const characterState = fixture.requests.filter(call => call.path === '/v1/semantic/changes/bulk')
      .flatMap(call => (call.body as { items: { properties: { predicate: string; value: unknown }[] }[] }).items)
      .find(item => item.properties.some(property => property.predicate === 'https://schema.org/name'
        && (property.value as { lexical?: string }).lexical === character.title.replace('\n', ' ')))!;
    expect(characterState.properties.filter(property => property.predicate === 'https://rezics.com/vocab/semanticWork'))
      .toEqual([{ predicate: 'https://rezics.com/vocab/semanticWork',
        value: { kind: 'resource', ref: journal.native[requested.roots[0]!].id } }]);
    const writes = fixture.requests.filter(call => call.key).length;
    const replay = await importDataset(directory, source, { ...options(fixture.api),
      selection: requested, maxRecords: 0 });
    expect(fixture.requests.filter(call => call.key)).toHaveLength(writes);
    expect(JSON.parse(readFileSync(replay.receiptFile, 'utf8')).native).toEqual(journal.native);
    expect(replay.selectionFile).toBe(accepted.selectionFile);
    const expanded = await importDataset(directory, source, { ...options(fixture.api),
      selection: { ...requested, relatedWorkDepth: 1 }, maxRecords: 1 });
    expect(expanded.records).toBe(5);
    expect(expanded.nativeRecords).toBe(6);
    const expandedJournal = JSON.parse(readFileSync(expanded.receiptFile, 'utf8'));
    for (const [key, native] of Object.entries(journal.native)) expect(expandedJournal.native[key]).toEqual(native);
    for (const [key, entry] of Object.entries(journal.entries)) expect(expandedJournal.entries[key]).toEqual(entry);
    expect(expanded.selectionFile).not.toBe(accepted.selectionFile);
    expect(JSON.parse(readFileSync(accepted.selectionFile!, 'utf8'))).toEqual(accepted.selection);
  });

  test('keeps the legacy prefix, exact intake intent and replay when selection is omitted', async () => {
    const directory = root(), fixture = apiFixture(), source = parent();
    const result = await importDataset(directory, source, { ...options(fixture.api), native: false, maxRecords: 1 });
    expect(result.records).toBe(1);
    expect(result.completed).toBe(false);
    expect(result).not.toHaveProperty('selection');
    expect(result).not.toHaveProperty('selectionFile');
    expect(existsSync(join(directory, 'imports', 'selections'))).toBe(false);
    const retained = recordIntakes(fixture);
    expect(retained).toHaveLength(1);
    expect(retained[0]!.envelope).toEqual({ format: 'rezics-dataset-record-v1',
      snapshot: source.id, digest: source.digest, record: source.sources[0]!.records[0],
      edges: [source.sources[0]!.edges[0]], images: [source.images[0]] });
    const saved = readFileSync(result.receiptFile, 'utf8'), writes = fixture.requests.filter(call => call.key).length;
    const replay = await importDataset(directory, source, { ...options(fixture.api), native: false, maxRecords: 1 });
    expect(replay.receiptFile).toBe(result.receiptFile);
    expect(readFileSync(result.receiptFile, 'utf8')).toBe(saved);
    expect(fixture.requests.filter(call => call.key)).toHaveLength(writes);
  });
});

describe('independent public-API dataset import', () => {
  test('lossless JSON parts respect intake byte bounds and detect missing/corrupt/reordered parts', () => {
    const source = {
      title: '命運'.repeat(50_000),
      nested: ['x', null, { roles: ['voice', 'staff'] }],
    };
    const parts = intakeChunks(source);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(65_536);
      expect(() => JSON.parse(part.toString())).not.toThrow();
    }
    expect(reconstructIntake(parts)).toEqual(source);
    expect(() => reconstructIntake(parts.slice(1))).toThrow();
    expect(() => reconstructIntake([...parts].reverse())).toThrow();
    const corrupted = JSON.parse(parts[0]!.toString());
    corrupted.bytes = Buffer.from('changed').toString('base64');
    expect(() =>
      reconstructIntake([Buffer.from(JSON.stringify(corrupted)), ...parts.slice(1)]),
    ).toThrow('Corrupt');
    expect(reconstructIntake(intakeChunks({ x: 1 }))).toEqual({ x: 1 });
  });

  test('replays exact committed request after lost response and resumes without duplicating records', async () => {
    const fixture = apiFixture(),
      directory = root(),
      source = snapshot([record('v11')]);
    fixture.loseNextResponse();
    const first = await importDataset(directory, source, {
      ...options(fixture.api),
      native: false,
    });
    expect(first.observations).toBe(2);
    const mutations = fixture.requests.filter((call) => call.path === '/v1/sources/intakes');
    expect(mutations[0]?.key).toBe(mutations[1]?.key);
    expect(mutations[0]?.body).toEqual(mutations[1]?.body);
    const count = fixture.receipts.size;
    await importDataset(directory, source, { ...options(fixture.api), native: false });
    expect(fixture.receipts.size).toBe(count);
    expect(fixture.requests.filter((call) => call.path === '/v1/sources/intakes')).toHaveLength(
      mutations.length,
    );
  });

  test('keeps complete relationships, API-allocated IDs, and useful Markdown headings/URLs', async () => {
    const fixture = apiFixture(),
      work = record('v11', 'work'),
      character = record('c22', 'character');
    work.title = 'Fate/stay night';
    character.title = 'Saber\n[Artoria]';
    const result = await importDataset(root(), snapshot([work, character]), options(fixture.api));
    expect(result.nativeRecords).toBe(2);
    const firstIntake = fixture.requests.find((call) => call.path === '/v1/sources/intakes')!
      .body as { rawBytesBase64: string };
    const evidence = JSON.parse(Buffer.from(firstIntake.rawBytesBase64, 'base64').toString());
    expect(evidence.edges[0].data).toEqual({ spoiler: 2, order: 1 });
    const creation = fixture.requests.find((call) => call.path === '/v1/work-imports/bulk')!;
    expect(creation.body).not.toHaveProperty('id');
    const semantic = fixture.requests.find((call) => call.path === '/v1/semantic/changes/bulk')!
      .body as { items: { properties: unknown[] }[] };
    expect(
      semantic.items[0]!.properties.some((property) =>
        JSON.stringify(property).includes('semanticWork'),
      ),
    ).toBe(true);
    const markdown = readFileSync(result.urlsFile, 'utf8');
    expect(markdown).toContain('### Saber Artoria (c22)');
    expect(markdown).toContain('http://127.0.0.1:3000/zh-Hant/w/');
    expect(markdown).toContain('http://127.0.0.1:3000/zh-Hant/e/');
    expect(markdown).toContain('/v1/sources/observations/');
    expect(markdown).not.toContain('3000/zh-Hant/sources/'); // source observations have API paths only
  });

  test('catalogue people stay source-qualified resources and never become controlled Agent identities', async () => {
    const fixture = apiFixture(),
      work = record('v11', 'work'),
      person = record('staff-1', 'person');
    work.title = 'Fate/stay night';
    person.title = 'Kinoko Nasu';
    const result = await importDataset(root(), snapshot([work, person]), options(fixture.api));
    expect(result.nativeRecords).toBe(2);
    expect(fixture.requests.some((call) => call.path === '/v1/agents')).toBe(false);
    const semantic = fixture.requests.find((call) => call.path === '/v1/semantic/changes/bulk')!
      .body as { items: { types: string[] }[] };
    expect(semantic.items[0]!.types).toEqual(['https://schema.org/Person']);
  });

  test('keeps partial URL receipts after a rejected write and aggregates later snapshots', async () => {
    const fixture = apiFixture(),
      directory = root(),
      source = snapshot([record('v11'), record('c22')]);
    const api: DatasetApi = {
      request(method, path, body, key) {
        if (
          path === '/v1/sources/intakes' &&
          (body as { externalId: string }).externalId === 'c22'
        ) {
          return Promise.resolve({ status: 403, body: { code: 'authority_denied' } });
        }
        return fixture.api.request(method, path, body, key);
      },
    };
    await expect(
      importDataset(directory, source, { ...options(api), native: false }),
    ).rejects.toThrow('HTTP 403');
    const partial = readFileSync(join(directory, 'urls.md'), 'utf8');
    expect(partial).toContain('### v11 Title (v11)');
    expect(partial).not.toContain('### c22 Title (c22)');
    await importDataset(directory, source, { ...options(fixture.api), native: false });
    const second = snapshot([record('other')]);
    second.id = 'another-snapshot';
    second.digest = 'b'.repeat(64);
    await importDataset(directory, second, { ...options(fixture.api), native: false });
    const combined = readFileSync(join(directory, 'urls.md'), 'utf8');
    expect(combined).toContain('## Snapshot test-snapshot');
    expect(combined).toContain('## Snapshot another-snapshot');
    expect(combined).toContain('### c22 Title (c22)');
    expect(combined).toContain('### other Title (other)');
  });

  test('bulk projections stay within API page bounds and rehydrate returned child identities after a crash', async () => {
    const fixture = apiFixture(),
      directory = root(),
      work = record('work', 'work');
    work.title = 'Fate/stay night';
    const children = Array.from({ length: 140 }, (_, index) =>
      record(`character-${index}`, 'character'),
    );
    const source = snapshot([work, ...children]);
    source.sources[0]!.edges = children.map((child) => ({
      from: work.key,
      to: child.key,
      kind: 'appearance',
      data: { role: 'main' },
    }));
    let lost = false;
    const api: DatasetApi = {
      async request(method, path, body, key) {
        const response = await fixture.api.request(method, path, body, key);
        if (path === '/v1/semantic/changes/bulk' && !lost) {
          lost = true;
          throw new Error('batch response lost after commit');
        }
        return response;
      },
    };
    const first = await importDataset(directory, source, { ...options(api), nativeBatchItems: 64 });
    expect(first.nativeRecords).toBe(141);
    const bulkCalls = fixture.requests.filter((call) => call.path === '/v1/semantic/changes/bulk');
    expect(bulkCalls).toHaveLength(4); // first64 replays once, then the remaining bounded batches
    expect(bulkCalls[0]!.key).toBe(bulkCalls[1]!.key);
    expect(bulkCalls[0]!.body).toEqual(bulkCalls[1]!.body);
    const journal = JSON.parse(readFileSync(first.receiptFile, 'utf8'));
    journal.native = {};
    // Simulate interruption between the atomic API result and summary checkpoint.
    writeFileSync(first.receiptFile, JSON.stringify(journal));
    const count = fixture.receipts.size;
    const resumed = await importDataset(directory, source, {
      ...options(fixture.api),
      nativeBatchItems: 128,
    });
    expect(resumed.nativeRecords).toBe(141);
    expect(fixture.receipts.size).toBe(count);
    const large = Array.from({ length: 40 }, (_, index) => ({
      key: String(index),
      state: { label: 'x'.repeat(10_000) },
    }));
    const batches = semanticBatches(large);
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches)
      for (let start = 0; start < batch.length; start += 16) {
        expect(
          batch
            .slice(start, start + 16)
            .reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item.state)) + 512, 0),
        ).toBeLessThanOrEqual(60_000);
      }
  });

  test('native batch size is bounded/configurable and128-item pages retain allocation margins', () => {
    expect(nativeBatchSize(undefined)).toBe(16);
    expect(nativeBatchSize('16')).toBe(16);
    expect(nativeBatchSize('128')).toBe(128);
    for (const invalid of ['0', '129', '1.5', '01', '-1', 'all'])
      expect(() => nativeBatchSize(invalid)).toThrow('integer');
    const items = Array.from({ length: 180 }, (_, index) => ({
      key: String(index),
      state: {
        component: 'resource',
        lifecycle: 'active',
        types: ['https://schema.org/Person'],
        properties: [
          {
            predicate: 'https://schema.org/name',
            value: { kind: 'language-string', language: 'ja', lexical: `Fixture${index}` },
          },
        ],
      },
    }));
    const batches = semanticBatches(items, 128);
    expect(batches.map((batch) => batch.length)).toEqual([128, 52]);
    for (const batch of batches) {
      let total = 0;
      for (let start = 0; start < batch.length; start += 16) {
        const page = batch
          .slice(start, start + 16)
          .reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item.state)) + 512, 0);
        expect(page).toBeLessThanOrEqual(60_000);
        total += page;
      }
      expect(total).toBeLessThanOrEqual(524_288);
    }
  });

  test('large cancelled batches reduce to16 only after immutable cancellation proof, preserving all source nodes', async () => {
    const fixture = apiFixture(),
      directory = root(),
      work = record('work', 'work');
    work.title = 'Fate/stay night';
    const children = Array.from({ length: 40 }, (_, i) => record(`character-${i}`, 'character'));
    const source = snapshot([work, ...children]);
    source.sources[0]!.edges = children.map((child) => ({
      from: work.key,
      to: child.key,
      kind: 'appearance',
      data: { role: 'main' },
    }));
    const pending: DatasetApi = {
      wait: async () => {},
      request(method, path, body, key) {
        if (path === '/v1/semantic/changes/bulk')
          return Promise.resolve({ status: 202, body: { status: 'reconciling', result: null } });
        return fixture.api.request(method, path, body, key);
      },
    };
    await expect(
      importDataset(directory, source, { ...options(pending), nativeBatchItems: 64 }),
    ).rejects.toThrow('remains pending');
    const proven: DatasetApi = {
      ...fixture.api,
      bulkStatus: async () => ({
        state: 'cancelled',
        admission: 'terminal-owner',
        receipt: `urn:rezics:receipt:${'b'.repeat(64)}`,
        dataEpoch: 'epoch-1',
        stageCount: 1,
      }),
    };
    const completed = await importDataset(directory, source, {
      ...options(proven),
      nativeBatchItems: 64,
    });
    expect(completed.nativeRecords).toBe(41);
    const activated = fixture.requests
      .filter((call) => call.path === '/v1/semantic/changes/bulk')
      .map((call) => (call.body as { items: unknown[] }).items.length);
    expect(activated).toEqual([16, 16, 8]);
  });

  test('rejected atomic semantic batches publish no invented native child IDs', async () => {
    const fixture = apiFixture(),
      directory = root(),
      work = record('work', 'work'),
      person = record('person', 'person');
    work.title = 'Fate/stay night';
    const api: DatasetApi = {
      request(method, path, body, key) {
        if (path === '/v1/semantic/changes/bulk')
          return Promise.resolve({ status: 422, body: { code: 'semantic_stage_nonconforming' } });
        return fixture.api.request(method, path, body, key);
      },
    };
    await expect(importDataset(directory, snapshot([work, person]), options(api))).rejects.toThrow(
      'HTTP 422',
    );
    const markdown = readFileSync(join(directory, 'urls.md'), 'utf8');
    expect(markdown).toContain('/zh-Hant/w/');
    expect(markdown).not.toContain('/zh-Hant/e/');
    expect(markdown).toContain('/v1/sources/observations/');
  });

  test('exhausted202 replies stay pending and never enter native registry or completion', async () => {
    const fixture = apiFixture(),
      directory = root(),
      work = record('work', 'work'),
      person = record('person', 'person');
    work.title = 'Fate/stay night';
    let attempts = 0;
    const api: DatasetApi = {
      wait: async () => {},
      request(method, path, body, key) {
        if (path === '/v1/semantic/changes/bulk') {
          attempts++;
          return Promise.resolve({
            status: 202,
            body: { operationId: 'urn:pending', status: 'reconciling', result: null },
          });
        }
        return fixture.api.request(method, path, body, key);
      },
    };
    await expect(importDataset(directory, snapshot([work, person]), options(api))).rejects.toThrow(
      'remains pending',
    );
    expect(attempts).toBe(8);
    const journals = readdirSync(join(directory, 'imports')).filter((name) =>
      name.endsWith('.json'),
    );
    const journal = JSON.parse(readFileSync(join(directory, 'imports', journals[0]!), 'utf8'));
    expect(journal.completed).toBe(false);
    expect(Object.keys(journal.native)).toEqual(['work']);
    const context = journals[0]!.slice(0, -5),
      files = readdirSync(join(directory, 'imports', context, 'requests')).filter((name) =>
        name.endsWith('.json'),
      );
    const pending = files
      .map((name) => ({
        name,
        saved: JSON.parse(
          readFileSync(join(directory, 'imports', context, 'requests', name), 'utf8'),
        ),
      }))
      .find((item) => item.saved.label.startsWith('native-bulk:'))!;
    expect(pending.saved.entry).not.toHaveProperty('result');
    // Older clients' false pending cache is recognized and replayed exactly.
    pending.saved.entry.result = {
      operationId: 'urn:pending',
      status: 'reconciling',
      result: null,
    };
    writeFileSync(
      join(directory, 'imports', context, 'requests', pending.name),
      JSON.stringify(pending.saved),
    );
    const resumed = await importDataset(directory, snapshot([work, person]), options(fixture.api));
    expect(resumed.nativeRecords).toBe(2);
  });

  test('replacement bulk keys require an immutable sameepoch cancellation proof', async () => {
    const fixture = apiFixture(),
      directory = root(),
      work = record('work', 'work'),
      person = record('person', 'person');
    work.title = 'Fate/stay night';
    const keys: string[] = [];
    const pending: DatasetApi = {
      wait: async () => {},
      bulkStatus: async () => ({
        state: 'unknown',
        admission: null,
        receipt: null,
        dataEpoch: null,
        stageCount: 0,
      }),
      request(method, path, body, key) {
        if (path === '/v1/semantic/changes/bulk') {
          keys.push(key!);
          return Promise.resolve({ status: 202, body: { status: 'reconciling', result: null } });
        }
        return fixture.api.request(method, path, body, key);
      },
    };
    await expect(
      importDataset(directory, snapshot([work, person]), options(pending)),
    ).rejects.toThrow('remains pending');
    await expect(
      importDataset(directory, snapshot([work, person]), options(pending)),
    ).rejects.toThrow('remains pending');
    expect(new Set(keys).size).toBe(1);
    const proven: DatasetApi = {
      ...fixture.api,
      bulkStatus: async () => ({
        state: 'cancelled',
        admission: 'owner-admission',
        receipt: `urn:rezics:receipt:${'a'.repeat(64)}`,
        dataEpoch: 'epoch-1',
        stageCount: 0,
      }),
    };
    const complete = await importDataset(directory, snapshot([work, person]), options(proven));
    expect(complete.nativeRecords).toBe(2);
    const actual = fixture.requests.find((call) => call.path === '/v1/semantic/changes/bulk')!;
    expect(actual.key).not.toBe(keys[0]);
    expect(complete.limitations.some((note) => note.includes('sealed cancellation'))).toBe(true);
  });

  test('canonicalizes real VNDB pt-br only in native labels and safely replaces unadmitted invalid projections', async () => {
    const fixture = apiFixture(),
      directory = root(),
      work = record('work', 'work'),
      producer = record('producer:p1074', 'organization');
    work.title = 'Fate/stay night';
    producer.language = 'pt-br';
    producer.data = { lang: 'pt-br', original: 'complete provider payload' };
    const source = snapshot([work, producer]);
    const neverAdmitted: DatasetApi = {
      wait: async () => {},
      bulkStatus: async () => ({
        state: 'unknown',
        admission: null,
        receipt: null,
        dataEpoch: null,
        stageCount: 0,
      }),
      request(method, path, body, key) {
        if (path === '/v1/semantic/changes/bulk')
          return Promise.resolve({ status: 400, body: { code: 'invalid_semantic_value' } });
        return fixture.api.request(method, path, body, key);
      },
    };
    await expect(importDataset(directory, source, options(neverAdmitted))).rejects.toThrow(
      'HTTP 400',
    );
    const journalName = readdirSync(join(directory, 'imports')).find((name) =>
      name.endsWith('.json'),
    )!;
    const folder = join(directory, 'imports', journalName.slice(0, -5), 'requests');
    const failed = readdirSync(folder)
      .filter((name) => name.endsWith('.json'))
      .map((name) => ({
        path: join(folder, name),
        saved: JSON.parse(readFileSync(join(folder, name), 'utf8')),
      }))
      .find((item) => item.saved.label.startsWith('native-bulk:'))!;
    failed.saved.entry.body.items[0].properties.find(
      (property: { predicate: string }) => property.predicate === 'https://schema.org/name',
    ).value.language = 'pt-br';
    writeFileSync(failed.path, JSON.stringify(failed.saved));
    const canonicalApi: DatasetApi = {
      ...neverAdmitted,
      request(method, path, body, key) {
        if (
          path === '/v1/semantic/changes/bulk' &&
          (
            body as {
              items: { properties: { predicate: string; value: { language?: string } }[] }[];
            }
          ).items[0]!.properties.some((property) => property.value.language === 'pt-br')
        )
          return Promise.resolve({ status: 400, body: { code: 'invalid_semantic_value' } });
        return fixture.api.request(method, path, body, key);
      },
    };
    const complete = await importDataset(directory, source, options(canonicalApi));
    expect(complete.nativeRecords).toBe(2);
    expect(
      JSON.parse(readFileSync(failed.path, 'utf8')).entry.body.items[0].properties[0].value
        .language,
    ).toBe('pt-br');
    expect(JSON.parse(readFileSync(failed.path, 'utf8')).entry.rejectionProof.status).toBe(400);
    const accepted = fixture.requests.find((call) => call.path === '/v1/semantic/changes/bulk')!
      .body as { items: { properties: { predicate: string; value: { language?: string } }[] }[] };
    expect(
      accepted.items[0]!.properties.find(
        (property) => property.predicate === 'https://schema.org/name',
      )!.value.language,
    ).toBe('pt-BR');
    const sourceIntake = fixture.requests.find(
      (call) =>
        call.path === '/v1/sources/intakes' &&
        (call.body as { externalId: string }).externalId === producer.externalId,
    )!.body as { rawBytesBase64: string };
    const retained = JSON.parse(Buffer.from(sourceIntake.rawBytesBase64, 'base64').toString());
    expect(retained.record.language).toBe('pt-br');
    expect(retained.record.data.lang).toBe('pt-br');
    expect(projectionLanguage('eng')).toBe('en');
    expect(projectionLanguage('{ja,en}')).toBe('und');
    expect(projectionLanguage('mul')).toBe('und');
  });

  test('catalogue imports keep stable item keys and retain partial successes for retry', async () => {
    const fixture = apiFixture(), directory = root(), works = [record('first','work'), record('second','work')];
    let once = true;
    const api: DatasetApi = { async request(method,path,body,key) {
      const response = await fixture.api.request(method,path,body,key);
      if (path === '/v1/work-imports/bulk' && once) {
        once = false;
        const result = structuredClone(response.body) as { items: { status: string; receipt?: unknown }[]; complete: boolean; partial: boolean };
        result.items[1]!.status = 'pending'; delete result.items[1]!.receipt; result.complete = false; result.partial = true;
        return { status: 200, body: result };
      }
      return response;
    } };
    await expect(importDataset(directory,snapshot(works),options(api))).rejects.toThrow('pending');
    await importDataset(directory,snapshot(works),options(api));
    const attempts = fixture.requests.filter(row => row.path === '/v1/work-imports/bulk');
    expect(attempts).toHaveLength(2); expect(attempts[0]!.body).toEqual(attempts[1]!.body);
  });

  test('one context has one writer, distinct contexts stay independent and released locks are reusable', () => {
    const first = sha256(crypto.randomUUID()),
      second = sha256(crypto.randomUUID());
    const releaseFirst = acquireDatasetImportLock(first),
      releaseSecond = acquireDatasetImportLock(second);
    try {
      expect(() => acquireDatasetImportLock(first)).toThrow('active writer');
    } finally {
      releaseFirst();
      releaseSecond();
    }
    const releaseAgain = acquireDatasetImportLock(first);
    releaseAgain();
    const stale = datasetImportLockPath(first);
    mkdirSync(stale);
    writeFileSync(join(stale, 'owner.json'), JSON.stringify({ pid: 2147483647 }));
    const releaseStale = acquireDatasetImportLock(first);
    releaseStale();
    expect(existsSync(stale)).toBe(false);
  });

  test('generic visibility uses one source-identity anchor while every qualified source relationship remains retained', async () => {
    const fixture = apiFixture(),
      z = record('work-z', 'work'),
      a = record('work-a', 'work'),
      tag = record('tag', 'concept');
    z.title = 'Z';
    a.title = 'A';
    tag.title = 'Shared trait';
    const source = snapshot([z, a, tag]);
    source.sources[0]!.edges = [
      { from: tag.key, to: z.key, kind: 'tagged-work', data: { spoiler: 2, score: 0.8 } },
      { from: tag.key, to: a.key, kind: 'tagged-work', data: { spoiler: 0, score: 0.9 } },
    ];
    const imported = await importDataset(root(), source, options(fixture.api));
    const aRequest = fixture.requests.find(
      (call) => call.path === '/v1/work-imports/bulk',
    )!;
    const aItems = fixture.receipts.get(aRequest.key!)!.items as { receipt: { work: string } }[];
    const aIndex = (aRequest.body as { items: { input: { title: string } }[] }).items.findIndex(item => item.input.title === 'A');
    const aIdentity = aItems[aIndex]!.receipt.work;
    const semantic = fixture.requests.find((call) => call.path === '/v1/semantic/changes/bulk')!
      .body as { items: { properties: { predicate: string; value: { ref?: string } }[] }[] };
    const anchors = semantic.items[0]!.properties.filter(
      (property) => property.predicate === 'https://rezics.com/vocab/semanticWork',
    );
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.value.ref).toBe(aIdentity);
    const intake = fixture.requests.find(
      (call) =>
        call.path === '/v1/sources/intakes' &&
        (call.body as { externalId: string }).externalId === 'tag',
    )!.body as { rawBytesBase64: string };
    const retained = JSON.parse(Buffer.from(intake.rawBytesBase64, 'base64').toString());
    expect(retained.edges).toEqual(source.sources[0]!.edges);
    expect(imported.limitations.some((note) => note.includes('one representative Work'))).toBe(
      true,
    );
  });

  test('music and book source episodes do not acquire a television episode classification', async () => {
    const fixture = apiFixture(),
      work = record('book', 'work'),
      chapter = record('chapter', 'episode');
    work.title = 'A novel';
    work.semanticTypes = ['https://schema.org/Book'];
    await importDataset(root(), snapshot([work, chapter]), options(fixture.api));
    const bulk = fixture.requests.find((call) => call.path === '/v1/semantic/changes/bulk')!
      .body as { items: { types: string[] }[] };
    expect(bulk.items[0]!.types).toEqual(['https://rezics.com/vocab/SourceDatasetEpisode']);
    const tv = apiFixture(),
      series = record('series', 'work'),
      episode = record('episode', 'episode');
    series.title = 'An anime series';
    series.semanticTypes = ['https://schema.org/TVSeries'];
    await importDataset(root(), snapshot([series, episode]), options(tv.api));
    const tvBulk = tv.requests.find((call) => call.path === '/v1/semantic/changes/bulk')!.body as {
      items: { types: string[] }[];
    };
    expect(tvBulk.items[0]!.types).toEqual(['https://schema.org/TVEpisode']);
  });

  test('rejects missing graph endpoints before writes and reports bounded partial imports', async () => {
    const fixture = apiFixture(),
      source = snapshot([record('v11'), record('c22')]);
    source.sources[0]!.edges[0]!.to = 'missing';
    await expect(importDataset(root(), source, options(fixture.api))).rejects.toThrow(
      'missing relationship endpoint',
    );
    expect(fixture.requests).toHaveLength(0);
    const partial = await importDataset(root(), snapshot([record('v11'), record('c22')]), {
      ...options(fixture.api),
      maxRecords: 1,
      native: false,
    });
    expect(partial.completed).toBe(false);
  });

  test('cover import resumes lost reserve transfer and selection replies', async () => {
    const fixture = apiFixture({ loseCoverReplies: ['reserve', 'transfer', 'selection'] });
    const directory = root();
    const work = record('subject-715', 'work');
    work.provider = 'bangumi';
    work.kind = 'subject';
    work.externalId = '715';
    work.sourceUrl = 'https://bgm.tv/subject/715';
    work.data = { description: 'long source record '.repeat(8_000), nested: { rank: 1 } };
    const cover = coverSnapshot(directory, work, {
      provider: 'bangumi', namespace: 'subject', externalId: '715', sourceName: 'Bangumi',
      sourceUrl: 'https://bgm.tv/subject/715', revision: null,
    });

    const first = await importDataset(directory, cover.snapshot, options(fixture.api));
    await importDataset(directory, cover.snapshot, options(fixture.api));

    expect(first.completed).toBe(true);
    expect(first.limitations.some(value => value.includes('cover pending'))).toBe(false);
    expect(fixture.nativeWorks).toHaveLength(1);
    const reserveCalls = fixture.requests.filter(call => call.path === '/v1/media/uploads');
    expect(reserveCalls.length).toBeGreaterThanOrEqual(3);
    expect(new Set(reserveCalls.map(call => call.key)).size).toBe(1);
    const reserveBody = reserveCalls[0]!.body as { importedCover: Record<string, unknown> };
    const importedCover = reserveBody.importedCover as {
      targetWork: string;
      source: { record: string; observation: string; observationDigest: string;
        datasetSnapshotDigest: string; recordDigest: string; externalId: string; sourceRevision: string | null };
      image: { captureUrl: string; captureDigest: string; byteLength: number; mediaType: string };
      originalDigest: string;
    };
    expect(importedCover.targetWork).toBe(fixture.nativeWorks[0]);
    expect(importedCover.source.externalId).toBe('715');
    expect(importedCover.source.sourceRevision).toBeNull();
    expect(importedCover.source.datasetSnapshotDigest).toBe(cover.snapshot.digest);
    expect(importedCover.source.recordDigest).toBe(cover.evidence.recordDigest);
    expect(importedCover.image.captureDigest).toBe(cover.image.capture!.digest);
    expect(importedCover.image.captureUrl).toBe(cover.image.url);
    expect(cover.evidence.captureUrl).not.toBe(cover.image.url);
    expect(importedCover.originalDigest).toBe(cover.image.capture!.digest);
    expect(importedCover.source.observationDigest).not.toBe(importedCover.image.captureDigest);
    expect(importedCover.source.record).toMatch(/^https:\/\/rezics\.com\/id\//);
    expect(importedCover.source.observation).toMatch(/^https:\/\/rezics\.com\/id\//);

    const coverEvidenceCall = fixture.requests.find(call => call.path === '/v1/sources/intakes'
      && (call.body as { coverage?: { scope?: string } }).coverage?.scope === 'cover-evidence')!;
    const evidenceBody = coverEvidenceCall.body as {
      namespace: string; externalId: string; sourceRevision: string | null;
      coverage: { scope: string; complete: boolean }; rawBytesBase64: string;
    };
    const envelopeBytes = Buffer.from(evidenceBody.rawBytesBase64, 'base64');
    const envelope = JSON.parse(envelopeBytes.toString()) as {
      profile: string; image: { captureUrl: string; captureDigest: string };
    };
    expect(evidenceBody).toMatchObject({ namespace: 'subject', externalId: '715', sourceRevision: null,
      coverage: { scope: 'cover-evidence', complete: false } });
    expect(envelope.profile).toBe('source-cover-evidence-v1');
    expect(envelope.image.captureDigest).toBe(cover.image.capture!.digest);
    expect(envelope.image.captureUrl).toBe(cover.image.url);
    expect(cover.evidence.captureUrl).not.toBe(envelope.image.captureUrl);
    expect(sha256(envelopeBytes)).toBe(importedCover.source.observationDigest);

    const recordParts = fixture.requests.filter(call => call.path === '/v1/sources/intakes'
      && (call.body as { namespace?: string }).namespace === 'subject-dataset-part')
      .map(call => Buffer.from((call.body as { rawBytesBase64: string }).rawBytesBase64, 'base64'));
    const reconstructed = reconstructIntake(recordParts) as { record: DatasetRecord };
    expect((reconstructed.record.data.description as string).length).toBeGreaterThan(65_536);
    expect(fixture.transfers.length).toBeGreaterThanOrEqual(3);
    for (const sent of fixture.transfers) {
      expect(sent.bytes).toEqual(cover.bytes);
      expect(sent.digest).toBe(cover.image.capture!.digest);
      expect(sent.path).toMatch(/^\/v1\/media\/uploads\/[0-9a-f-]{36}\/bytes$/);
    }
    const selectionCalls = fixture.requests.filter(call => call.path.endsWith('/avatar'));
    expect(selectionCalls.length).toBeGreaterThanOrEqual(3);
    expect(new Set(selectionCalls.map(call => call.key)).size).toBe(1);
    expect(fixture.requests.filter(call => call.path.includes('actingSubject=')).length).toBe(1);
    expect(fixture.requests.some(call => call.path === cover.evidence.captureUrl)).toBe(false);

    const requestDirectory = join(dirname(first.receiptFile), basename(first.receiptFile, '.json'), 'requests');
    const journalEntries = readdirSync(requestDirectory).filter(file => file.endsWith('.json'))
      .map(file => readFileSync(join(requestDirectory, file), 'utf8')).join('\n');
    expect(journalEntries).not.toContain(cover.bytes.toString('base64'));
    expect(journalEntries).toContain(cover.image.capture!.digest);
    expect(journalEntries).toContain(`raw/blobs/${cover.image.capture!.digest}`);
  });

  test('cover import rejects mismatched capture digests or unrelated capture URLs', async () => {
    for (const defect of [
      'source record digest',
      'image digest',
      'source capture URL',
      'image capture URL',
    ] as const) {
      const fixture = apiFixture();
      const directory = root();
      const work = record(`invalid-cover-${defect.replaceAll(' ', '-')}`, 'work');
      const cover = coverSnapshot(directory, work);
      if (defect === 'source record digest')
        cover.evidence.recordDigest = 'f'.repeat(64);
      else if (defect === 'image digest')
        cover.image.capture!.digest = 'f'.repeat(64);
      else if (defect === 'source capture URL')
        cover.evidence.captureUrl = 'https://records.example.test/unrelated.json';
      else
        cover.image.capture!.url = 'https://images.example.test/covers/unrelated.png';

      const result = await importDataset(directory, cover.snapshot, options(fixture.api));

      expect(result.limitations.some(value => value.includes('cover pending'))).toBe(true);
      expect(fixture.requests.some(call => call.path === '/v1/media/uploads')).toBe(false);
      expect(fixture.transfers).toHaveLength(0);
      expect(fixture.requests.some(call => call.path.endsWith('/avatar'))).toBe(false);
    }
  });

  test('cover pending denied restricted and unavailable outcomes preserve imported facts', async () => {
    for (const outcome of ['denied', 'restricted', 'unavailable'] as const) {
      const fixture = apiFixture();
      if (outcome === 'denied') fixture.denyCovers();
      if (outcome === 'restricted') fixture.suppressCovers();
      if (outcome === 'unavailable') fixture.makeCoversUnavailable();
      const directory = root();
      const work = record(`facts-${outcome}`, 'work');
      const cover = coverSnapshot(directory, work);
      const log: string[] = [];
      const result = await importDataset(directory, cover.snapshot,
        { ...options(fixture.api), progress: message => log.push(message) });

      expect(result.completed).toBe(true);
      expect(result.nativeRecords).toBeGreaterThan(0);
      expect(result.limitations.some(value => value.includes('cover pending'))).toBe(true);
      const retainedFacts = fixture.requests.filter(call => call.path === '/v1/sources/intakes'
        && (call.body as { coverage?: { scope?: string } }).coverage?.scope !== 'cover-evidence');
      expect(retainedFacts.length).toBeGreaterThanOrEqual(2);
      expect(fixture.requests.some(call => call.path === '/v1/media/uploads')).toBe(true);
      expect(fixture.transfers).toHaveLength(0);
      expect(fixture.requests.some(call => call.path.endsWith('/avatar'))).toBe(false);
      if (outcome === 'denied') {
        expect(result.coverResults).toEqual([{
          record: sha256(work.key), status: 'pending', step: 'reservation',
          reasonCode: 'reservation-refused', httpStatus: 403, problemType: 'authority_denied',
        }]);
        expect(log).toContain(`Imported cover ${sha256(work.key).slice(0, 16)} pending step=reservation`
          + ' reason=reservation-refused HTTP 403 problem=authority_denied');
        expect(log.join('\n')).not.toContain('https://');
      }
    }
  });

  test('a configured second provider uses the identical cover API sequence', async () => {
    const fixture = apiFixture();
    const directory = root();
    const work = record('musicbrainz-work', 'work');
    work.provider = 'musicbrainz';
    work.kind = 'recording';
    work.externalId = 'requested-recording-id';
    work.sourceUrl = 'https://musicbrainz.org/recording/requested-recording-id';
    const cover = coverSnapshot(directory, work, {
      provider: 'musicbrainz', namespace: 'recording', externalId: 'elected-recording-id',
      revision: 'release-revision-17', sourceName: 'MusicBrainz',
      sourceUrl: 'https://musicbrainz.org/recording/elected-recording-id',
    });
    await importDataset(directory, cover.snapshot, options(fixture.api));

    const reservation = fixture.requests.find(call => call.path === '/v1/media/uploads')!.body as {
      importedCover: { targetWork: string; source: { provider: string; namespace: string; externalId: string;
        sourceRevision: string | null; href: string } };
    };
    expect(reservation.importedCover).toMatchObject({
      targetWork: fixture.nativeWorks[0],
      source: { provider: 'musicbrainz', namespace: 'recording', externalId: 'elected-recording-id',
        sourceRevision: 'release-revision-17', href: 'https://musicbrainz.org/recording/elected-recording-id' },
    });
    expect(fixture.transfers).toHaveLength(1);
    expect(fixture.requests.filter(call => call.path === '/v1/media/uploads')).toHaveLength(1);
    expect(fixture.requests.filter(call => call.path.endsWith('/avatar'))).toHaveLength(1);
    expect(fixture.requests.some(call => call.path.includes('requested-recording-id'))).toBe(false);
  });

  test('import retry never replaces an editor cover after stale selection', async () => {
    const fixture = apiFixture({ editorBeforeSelection: true });
    const directory = root();
    const work = record('stale-cover-work', 'work');
    const cover = coverSnapshot(directory, work);
    const first = await importDataset(directory, cover.snapshot, options(fixture.api));
    expect(first.completed).toBe(true);
    expect(first.limitations.some(value => value.includes('stale selection'))).toBe(true);
    const nativeWork = fixture.nativeWorks[0]!;
    const editorSelection = uuid(7999);
    expect(fixture.currentSelections.get(nativeWork)).toBe(editorSelection);

    const second = await importDataset(directory, cover.snapshot, options(fixture.api));
    const selectionCalls = fixture.requests.filter(call => call.path.endsWith('/avatar'));
    expect(second.limitations.some(value => value.includes('stale selection'))).toBe(true);
    expect(selectionCalls).toHaveLength(2);
    expect(new Set(selectionCalls.map(call => call.key)).size).toBe(1);
    expect(selectionCalls.every(call => (call.body as { expectedSelection: string | null }).expectedSelection === null)).toBe(true);
    expect(fixture.requests.filter(call => call.path.includes('actingSubject=')).length).toBe(1);
    expect(fixture.currentSelections.get(nativeWork)).toBe(editorSelection);
  });

  test('a refused re-import of a taken-down cover leaves the facts and reports pending', async () => {
    const fixture = apiFixture();
    const directory = root();
    const work = record('taken-down-cover-work', 'work');
    const cover = coverSnapshot(directory, work);
    const first = await importDataset(directory, cover.snapshot, options(fixture.api));
    expect(first.limitations.some(value => value.includes('cover pending'))).toBe(false);
    expect(fixture.transfers).toHaveLength(1);
    const factIntakesBefore = fixture.requests.filter(call => call.path === '/v1/sources/intakes'
      && (call.body as { coverage?: { scope?: string } }).coverage?.scope !== 'cover-evidence').length;
    const selected = fixture.requests.filter(call => call.path.endsWith('/avatar')).length;

    fixture.suppressCovers();
    const retry = await importDataset(directory, cover.snapshot, options(fixture.api));

    expect(retry.completed).toBe(true);
    expect(retry.limitations.some(value => value.includes('cover pending') && value.includes('restricted'))).toBe(true);
    expect(fixture.requests.filter(call => call.path === '/v1/sources/intakes'
      && (call.body as { coverage?: { scope?: string } }).coverage?.scope !== 'cover-evidence')).toHaveLength(factIntakesBefore);
    expect(fixture.transfers).toHaveLength(1);
    expect(fixture.requests.filter(call => call.path.endsWith('/avatar'))).toHaveLength(selected);
  });
});

test('development auth registers and installs a public client, consents and exchanges PKCE without owner-store access', async () => {
  const directory = root(),
    userId = crypto.randomUUID();
  mkdirSync(join(directory, 'web-auth'));
  writeFileSync(
    join(directory, 'dev.env'),
    'MAIN_ORIGIN=http://127.0.0.1:3301\nACCOUNT_ORIGIN=http://127.0.0.1:3304\nACCOUNT_SERVICE_ORIGIN=http://127.0.0.1:3302\nMAIN_DATA_EPOCH=00000000-0000-4000-8000-000000000111\n',
  );
  writeFileSync(
    join(directory, 'web-auth/public.json'),
    JSON.stringify({
      clientId: 'old-web-client',
      redirectUris: ['http://127.0.0.1:3300/auth/callback'],
      resource: 'https://main.rezics.test',
    }),
  );
  writeFileSync(
    join(directory, 'web-auth/private.json'),
    JSON.stringify({
      operator: { id: userId, email: 'test-operator@example.test', password: 'mock-password-only' },
    }),
  );
  const prior = globalThis.fetch,
    paths: string[] = [];
  let tokenExchangeCount = 0,
    rejectFirstTransfer = true;
  const response = (body: unknown, status = 200, headers?: HeadersInit) =>
    Response.json(body, { status, headers });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    if (url.pathname === '/api/auth/sign-in/email')
      return response({ user: { id: userId } }, 200, { 'set-cookie': 'session=mock-fixture' });
    if (url.pathname === '/api/auth/oauth2/create-client') {
      expect(new Headers(init?.headers).get('x-account-reason')).toBeTruthy();
      const body = JSON.parse(String(init?.body));
      expect(body).not.toHaveProperty('skip_consent');
      return response({ client_id: 'public-dataset-client' }, 201);
    }
    if (url.pathname === '/api/account/installations/public-dataset-client')
      return response({ error: 'not_found' }, 404);
    if (url.pathname === '/api/account/installation-changes') {
      expect(JSON.parse(String(init?.body))).toHaveProperty('change', 'install');
      return response({ state: 'active' });
    }
    if (url.pathname === '/api/account/policies')
      return response({ acceptanceRequired: false, policies: [] });
    if (url.pathname === '/api/auth/oauth2/authorize') {
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      return new Response(null, {
        status: 302,
        headers: {
          location: 'http://127.0.0.1:3304/consent?sig=mock-signed-query&scope=source%3Aintake',
        },
      });
    }
    if (url.pathname === '/api/account/consent') {
      expect(JSON.parse(String(init?.body))).toHaveProperty('accept', true);
      return response({
        redirect: true,
        url: 'http://127.0.0.1:3300/auth/callback?code=mock-code',
      });
    }
    if (url.pathname === '/api/auth/oauth2/token') {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get('code_verifier')?.length).toBeGreaterThan(30);
      tokenExchangeCount++;
      return response({ access_token: 'mock-access-token-not-written' });
    }
    if (url.pathname === `/v1/media/uploads/${uuid(7654)}/bytes`) {
      expect(url.origin).toBe('http://127.0.0.1:3301');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer mock-access-token-not-written');
      expect(new Headers(init?.headers).get('content-type')).toBe('application/octet-stream');
      expect(Buffer.from(init?.body as Uint8Array)).toEqual(Buffer.from('binary cover bytes'));
      if (rejectFirstTransfer) {
        rejectFirstTransfer = false;
        return response({ code: 'expired_token' }, 401);
      }
      return response({ status: 'activated' }, 201);
    }
    if (url.pathname === '/v1/agents') return response({ agent: iri(7777), state: 'active' }, 201);
    throw new Error(`Unexpected auth route ${url.pathname}`);
  }) as typeof fetch;
  const scope =
    'openid agent:create work:create work:edit work:read source:intake source:read classification:define classification:decide statement:write semantic:read rights:assess';
  const clientPath = join(
    repository,
    '.temp/datasets',
    `oauth-${sha256(`http://127.0.0.1:3304:${userId}:${scope}:${datasetStackMarker('00000000-0000-4000-8000-000000000111', userId)}`)}.json`,
  );
  try {
    const session = await localDatasetSession(directory, 'operator');
    expect(session.actingSubject).toBe(iri(7777));
    const transfer = await session.api.transfer!(`/v1/media/uploads/${uuid(7654)}/bytes`,
      Buffer.from('binary cover bytes'));
    expect(transfer).toMatchObject({ status: 201, body: { status: 'activated' } });
    expect(tokenExchangeCount).toBe(2);
    await expect(session.api.transfer!('https://images.example.test/cover.png', Buffer.from('secret')))
      .rejects.toThrow('Main upload destination');
    expect(paths).not.toContain('/api/auth/admin/oauth2/create-client');
    expect(readFileSync(clientPath, 'utf8')).not.toContain('mock-access-token-not-written');
    expect(readFileSync(clientPath, 'utf8')).not.toContain('mock-password-only');
  } finally {
    globalThis.fetch = prior;
    rmSync(clientPath, { force: true });
  }
});
