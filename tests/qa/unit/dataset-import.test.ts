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
import { canonical, putBlob, repository, sha256 } from '../../../scripts/datasets/store.ts';
import type { DatasetSelectionBudget } from '../../../scripts/datasets/selection.ts';
import { datasetStackMarker } from '../../../scripts/datasets/bootstrap.ts';
import { acquireDatasetImportLock, datasetImportLockPath } from '../../../scripts/datasets/lock.ts';
import type { DatasetCoverEvidence, DatasetRecord, DatasetSnapshot, StoredImage } from '../../../scripts/datasets/types.ts';
import type { DatasetNativeMapper, DatasetNativeRecord } from '../../../scripts/datasets/types.ts';
import { testDatasetImportCoverage } from '../../../scripts/datasets/conformance.ts';
import { DatasetIntakeCustodyError } from '../../../scripts/datasets/native/context.ts';
import type {
  DatasetFieldAdoptionJournal, DatasetIntakeJournal, DatasetIntakeRequest, DatasetRecordEnvelope, DatasetSourceReference,
} from '../../../scripts/datasets/types.ts';
import type { RetainedConversionRequest, RetainedSupportRequest } from '../../../services/main/src/modules/source/field-support-contract.ts';
import { SOURCE_NORMALIZATION, verifyRetainedRecord } from '../../../services/main/src/modules/source/retained-record-normalization.ts';
import { synopsisSlot } from '../../../services/main/src/modules/source/field-control-native.ts';
import type { StagedSourceObservation } from '../../../services/main/src/modules/source/intake.ts';

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
    sourceRecords = new Map<string, string>(),
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
      if (receipts.has(key)) return { status: 200, body: path === '/v1/sources/intakes'
        ? { ...receipts.get(key)!, replayed: true } : receipts.get(key)! };
      let receipt: Record<string, unknown>;
      if (path === '/v1/sources/intakes') {
        const intake = body as DatasetIntakeRequest;
        const bytes = Buffer.from(intake.rawBytesBase64, 'base64');
        const identity = canonical([intake.provider, intake.namespace, intake.externalId]);
        let sourceRecord = sourceRecords.get(identity);
        if (!sourceRecord) { sourceRecord = iri(id++); sourceRecords.set(identity, sourceRecord); }
        receipt = { observation: { ...structuredClone(intake), state: 'staged',
          observation: iri(id++), record: sourceRecord, byteDigest: sha256(bytes), byteLength: bytes.length,
          submittedAt: '2026-10-19T00:00:00Z' }, replayed: false };
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

// Fixture serialization follows the frozen format. These transport assertions do
// not establish provider archive custody, adoption, rights or public byte delivery.
function sealSnapshot(value: DatasetSnapshot): DatasetSnapshot {
  const capture = ({ url, digest, bytes, mediaType }: NonNullable<StoredImage['capture']>) =>
    ({ url, digest, bytes, mediaType });
  value.digest = sha256(canonical({ format: value.format, sources: value.sources,
    captures: value.captures.map(capture), images: value.images.map(image => ({ ...image,
      capture: image.capture ? capture(image.capture) : null })) }));
  return value;
}

function coverSnapshot(directory: string, sourceRecord: DatasetRecord, source?: Partial<DatasetCoverEvidence>) {
  const bytes = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    Buffer.from('pinned dataset cover bytes\u0000with exact digest')]);
  const imageUrl = 'https://images.example.test/covers/pinned.png';
  const sourceProvider = source?.provider ?? sourceRecord.provider;
  const sourceNamespace = source?.namespace ?? sourceRecord.kind;
  const sourceExternalId = source?.externalId ?? sourceRecord.externalId;
  const sourceCaptureUrl = source?.captureUrl
    ?? (sourceProvider === 'bangumi' ? `https://api.bgm.tv/v0/subjects/${sourceExternalId}`
      : `https://records.example.test/${sourceProvider}/${sourceNamespace}/${encodeURIComponent(sourceExternalId)}`);
  const recordBytes = Buffer.from(JSON.stringify({ id: sourceProvider === 'bangumi' ? Number(sourceExternalId) : sourceExternalId,
    images: { large: imageUrl } }));
  const recordDigest = putBlob(directory, recordBytes);
  const evidence: DatasetCoverEvidence = {
    provider: sourceProvider,
    namespace: sourceNamespace,
    externalId: sourceExternalId,
    revision: null,
    captureUrl: sourceCaptureUrl,
    recordDigest,
    field: '/images/large',
    sourceName: 'Reviewed source',
    sourceUrl: sourceRecord.sourceUrl,
    holder: null,
    ...source,
  };
  sourceRecord.provider = sourceProvider as DatasetRecord['provider'];
  sourceRecord.kind = sourceNamespace;
  sourceRecord.externalId = sourceExternalId;
  sourceRecord.key = `${sourceProvider}:${sourceNamespace}:${sourceExternalId}`;
  sourceRecord.sourceUrl = evidence.sourceUrl;
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
  value.sources[0]!.provider = sourceRecord.provider;
  value.captures = [{ url: evidence.captureUrl, digest: evidence.recordDigest,
    bytes: recordBytes.length, mediaType: 'application/json', fetchedAt: '2026-10-02T00:00:00Z',
    etag: null, lastModified: null }];
  value.images = [image];
  value.sources[0]!.images = [{ record: image.record, role: image.role, url: image.url, sourceEvidence: evidence }];
  return { snapshot: sealSnapshot(value), bytes, image, evidence };
}

const options = (api: DatasetApi) => ({
  api,
  actingSubject: iri(9000),
  mainOrigin: 'http://127.0.0.1:3001',
  webOrigin: 'http://127.0.0.1:3000',
});

const selectionBudget: DatasetSelectionBudget = {
  maxInputItems: 10_000, maxRecords: 100, maxEdges: 1000, maxImages: 1000,
  maxJsonBytes: 4 * 1024 * 1024, maxMediaBytes: 4 * 1024 * 1024,
};

const retainedCases = [
  ['vndb', 'vn', 'v11', 'https://vndb.org/v11'],
  ['bangumi', 'subject', '1014', 'https://bgm.tv/subject/1014'],
  ['musicbrainz', 'artist', '24f1766e-9635-4d58-a4d4-9413f9f98a4c',
    'https://musicbrainz.org/artist/24f1766e-9635-4d58-a4d4-9413f9f98a4c'],
  ['musicbrainz', 'release', '2ab08baa-b1c6-4aca-8cf7-c31565ef71b4',
    'https://musicbrainz.org/release/2ab08baa-b1c6-4aca-8cf7-c31565ef71b4'],
] as const;
function retainedCase(index: number, multipart: boolean): DatasetRecord {
  const [provider, kind, externalId, sourceUrl] = retainedCases[index]!;
  return { ...record(`${provider}:${kind}:${externalId}`), provider, kind, externalId, sourceUrl,
    data: { alias: 'Frozen alias', count: 0, omitted: null, ...(multipart ? { text: '字'.repeat(40_000) } : {}) } };
}
function freezeSnapshotFile(directory: string, source: DatasetSnapshot): Buffer {
  const file = join(directory, 'snapshots', source.id, 'snapshot.json');
  mkdirSync(dirname(file), { recursive: true });
  const bytes = Buffer.from(JSON.stringify(source, null, 2) + '\n');
  writeFileSync(file, bytes);
  return bytes;
}
function intakeJournal(file: string): DatasetIntakeJournal {
  return JSON.parse(readFileSync(file, 'utf8'));
}
function requestFile(receiptFile: string, label: string): string {
  return join(receiptFile.slice(0, -5), 'requests', sha256(label) + '.json');
}

describe('actual importer intake custody', () => {
  for (const multipart of [false, true]) test(`preserves the original unknown-rights ${multipart ? 'multipart' : 'single-part'} requests and status-less acknowledgements`, async () => {
    const fixture = apiFixture(), directory = root(), original = retainedCase(0, multipart);
    const source = sealSnapshot(snapshot([original])), frozen = freezeSnapshotFile(directory, source);
    const result = await importDataset(directory, source, { ...options(fixture.api), native: false });
    const retained = intakeJournal(result.intakeReceiptsFile).records[original.key]!;
    const historical = retained.intakes.map(part => {
      const file = requestFile(result.receiptFile, part.command.label), saved = JSON.parse(readFileSync(file, 'utf8'));
      const rights = { basis: 'unknown',
        note: `Frozen local development evidence from ${original.sourceUrl}; raw provider data and images retain their original rights. No redistribution permission is asserted.` };
      saved.entry.body.rightsEvidence = rights;
      saved.entry.result.observation.rightsEvidence = rights;
      delete saved.entry.result.observation.rawBytesBase64;
      // The retained pre-custody journals have requests and owner results, with
      // no producer coordinate annotation or recorded HTTP status.
      delete saved.entry.intake;
      delete saved.entry.responses;
      delete saved.entry.responseStatus;
      writeFileSync(file, JSON.stringify(saved));
      return { file, label: part.command.label, key: part.command.key, entry: saved.entry };
    });
    const calls = fixture.requests.length;
    for (let replay = 0; replay < 2; replay++) {
      const replayed = await importDataset(directory, source, { ...options(fixture.api), native: false });
      const receipts = intakeJournal(replayed.intakeReceiptsFile).records[original.key]!;
      expect(receipts.intakes).toHaveLength(historical.length);
      for (const [index, part] of receipts.intakes.entries()) {
        const prior = historical[index]!, command = part.command;
        expect(command.label).toBe(prior.label);
        expect(command.key).toBe(prior.key);
        expect(command.request).toEqual(prior.entry.body);
        expect(command.result).toEqual(prior.entry.result);
        expect(command.responses).toEqual([{ body: prior.entry.result }]);
        expect(command.responses[0]).not.toHaveProperty('status');
        expect(command.coordinate).toEqual(retained.intakes[index]!.command.coordinate);
        expect(command.request.rightsEvidence.basis).toBe('unknown');
        expect(part.byteDigest).toBe(retained.intakes[index]!.byteDigest);
        const persisted = JSON.parse(readFileSync(prior.file, 'utf8')).entry;
        expect(persisted.body).toEqual(prior.entry.body);
        expect(persisted.result).toEqual(prior.entry.result);
      }
      expect(fixture.requests.slice(calls).every(call => call.path === '/v1/catalogue/candidates')).toBe(true);
      expect(readFileSync(join(directory, 'snapshots', source.id, 'snapshot.json'))).toEqual(frozen);
    }
    const first = historical[0]!, before = readFileSync(first.file, 'utf8'), changed = JSON.parse(before);
    changed.entry.body.rightsEvidence.note += ' unrelated claim';
    changed.entry.result.observation.rightsEvidence = changed.entry.body.rightsEvidence;
    writeFileSync(first.file, JSON.stringify(changed));
    const error = await importDataset(directory, source, { ...options(fixture.api), native: false }).catch(error => error);
    expect(error).toBeInstanceOf(DatasetIntakeCustodyError);
    expect(error.basis).toBe('request');
    expect(error.message).toContain('rightsEvidence');
    expect(fixture.requests.slice(calls).every(call => call.path === '/v1/catalogue/candidates')).toBe(true);
    writeFileSync(first.file, before);
  });

  for (const multipart of [false, true]) for (let index = 0; index < retainedCases.length; index++) {
    const key = retainedCases[index]!.slice(0, 3).join(':');
    test(`retains exact ${multipart ? 'multipart' : 'single-part'} request/reply bindings for ${key}`, async () => {
      const fixture = apiFixture(), directory = root(), original = retainedCase(index, multipart);
      const source = sealSnapshot(snapshot([original]));
      const frozen = freezeSnapshotFile(directory, source);
      const result = await importDataset(directory, source, { ...options(fixture.api), native: false });
      const receipts = intakeJournal(result.intakeReceiptsFile), retained = receipts.records[original.key]!;
      expect(receipts.snapshot).toEqual({ id: source.id, digest: source.digest, fileSha256: sha256(frozen) });
      expect(retained.identity).toEqual({ key: original.key, provider: original.provider,
        namespace: original.kind, externalId: original.externalId });
      expect(retained.envelope).toEqual({ format: 'rezics-dataset-record-v1', snapshot: source.id,
        digest: source.digest, record: original, edges: [], images: [] });
      expect(retained.record).toEqual(original);
      expect(retained.recordDigest).toBe(sha256(canonical(original)));
      expect(retained.intakes.length > 1).toBe(multipart);
      expect(retained.payload).toEqual({ format: multipart ? 'rezics-dataset-chunk-v1' : 'json',
        byteDigest: sha256(canonical(retained.envelope)), byteLength: Buffer.byteLength(canonical(retained.envelope)) });
      const buffers: Buffer[] = [];
      for (const [partIndex, part] of retained.intakes.entries()) {
        const command = part.command, submitted = command.request;
        expect(part.index).toBe(partIndex);
        expect(command.coordinate.identity).toEqual(retained.identity);
        expect(command.coordinate.snapshot).toEqual(receipts.snapshot);
        expect(command.coordinate.index).toBe(partIndex);
        expect(command.coordinate.count).toBe(retained.intakes.length);
        expect(submitted.namespace).toBe(multipart ? `${original.kind}-dataset-part` : original.kind);
        expect(submitted.externalId).toBe(multipart ? `${original.externalId}:part:${partIndex}` : original.externalId);
        expect(submitted.mediaType).toBe('application/json');
        expect(submitted.retention).toBe('retained');
        expect(submitted.coverage.complete).toBe(!multipart);
        expect(submitted.rightsEvidence.basis).toBe(original.provider === 'musicbrainz' ? 'unknown' : 'license');
        expect(submitted.rightsEvidence.note).toContain(original.sourceUrl);
        expect(command.request).toEqual(fixture.requests.find(call => call.key === command.key)!.body);
        expect(command.result).toEqual(fixture.receipts.get(command.key)!);
        expect(command.responses).toEqual([{ status: 201, body: command.result }]);
        const bytes = Buffer.from(submitted.rawBytesBase64, 'base64'); buffers.push(bytes);
        expect(part.byteDigest).toBe(sha256(bytes));
        expect(part.byteLength).toBe(bytes.length);
        expect((command.result.observation as Record<string, unknown>).record).toBe(part.record);
        expect(retained.recordDigest).not.toBe(part.byteDigest);
      }
      expect(reconstructIntake(buffers)).toEqual(retained.envelope);
      expect(new Set(retained.intakes.map(part => part.record)).size).toBe(retained.intakes.length);
      expect(Object.hasOwn(retained, 'sourceRecord')).toBe(false);
      expect(receipts.unboundCommands).toEqual([]);
      const before = readFileSync(result.intakeReceiptsFile, 'utf8');
      const calls = fixture.requests.filter(call => call.path === '/v1/sources/intakes').length;
      await importDataset(directory, source, { ...options(fixture.api), native: false });
      expect(readFileSync(result.intakeReceiptsFile, 'utf8')).toBe(before);
      expect(fixture.requests.filter(call => call.path === '/v1/sources/intakes')).toHaveLength(calls);
      expect(readFileSync(join(directory, 'snapshots', source.id, 'snapshot.json'))).toEqual(frozen);
    });

    test(`refuses self-consistent unrelated ${multipart ? 'part' : 'source'} coordinates for ${key}`, async () => {
      const fixture = apiFixture(), directory = root(), original = retainedCase(index, multipart), source = snapshot([original]);
      const result = await importDataset(directory, source, { ...options(fixture.api), native: false });
      const command = intakeJournal(result.intakeReceiptsFile).records[original.key]!.intakes[multipart ? 1 : 0]!.command;
      const file = requestFile(result.receiptFile, command.label), before = readFileSync(file, 'utf8');
      for (const field of ['namespace', 'externalId'] as const) {
        const saved = JSON.parse(before);
        saved.entry.body[field] += '-unrelated';
        saved.entry.result.observation[field] = saved.entry.body[field];
        for (const reply of saved.entry.responses) reply.body.observation[field] = saved.entry.body[field];
        writeFileSync(file, JSON.stringify(saved));
        const calls = fixture.requests.length;
        const error = await importDataset(directory, source, { ...options(fixture.api), native: false }).catch(error => error);
        expect(error).toBeInstanceOf(DatasetIntakeCustodyError);
        expect(error.basis).toBe('coordinate');
        expect(error.message).toContain(field);
        expect(error.owner).toBe('dataset-importer');
        expect(error.stage).toBe('import-intake-receipts');
        expect(fixture.requests.slice(calls).every(call => call.path === '/v1/catalogue/candidates')).toBe(true);
        writeFileSync(file, before);
      }
    });
  }

  for (const multipart of [false, true]) test(`checks the whole ${multipart ? 'multipart' : 'single-part'} envelope and original selected indices`, async () => {
    const fixture = apiFixture(), directory = root(), original = { ...retainedCase(0, multipart), native: 'work' as const };
    const outside = record('outside'), child = record('child', 'character');
    const source = snapshot([outside, original, child]);
    source.sources[0]!.edges = [{ from: outside.key, to: child.key, kind: 'character', data: { order: 0 } },
      { from: original.key, to: child.key, kind: 'character', data: { order: 1 } }];
    source.images = [outside.key, original.key, original.key].map((key, index) => ({ record: key,
      role: index === 1 ? 'candidate-cover' : 'selected-cover', url: `https://images.example.test/${index}.png`,
      captureRole: 'cover', capture: null, missing: true }));
    source.sources[0]!.images = source.images.map(({ record, role, url }) => ({ record, role, url }));
    sealSnapshot(source);
    const before = canonical(source);
    const importOptions = { ...options(fixture.api), native: false,
      selection: { roots: [original.key], budget: selectionBudget, relatedWorkDepth: 0 } };
    const result = await importDataset(directory, source, importOptions);
    const retained = intakeJournal(result.intakeReceiptsFile).records[original.key]!;
    expect(retained.envelope.edges).toEqual([source.sources[0]!.edges[1]!]);
    expect(retained.envelope.images).toEqual(source.images.slice(1));
    expect(retained.occurrences).toEqual({ edges: ['/sources/0/edges/1'],
      images: ['/images/1', '/images/2'], electedImages: ['/images/2'] });
    const parentContext = sha256(canonical([importOptions.mainOrigin, importOptions.actingSubject,
      result.dataEpoch, source.id, source.digest]));
    const originals = retained.intakes.map(part => {
      const file = requestFile(join(directory, 'imports', `${parentContext}.json`), part.command.label);
      return { file, before: readFileSync(file, 'utf8') };
    });
    const mutations: [keyof DatasetRecordEnvelope, unknown][] = [
      ['snapshot', 'another-snapshot'], ['digest', '0'.repeat(64)], ['edges', []], ['images', []],
      ['record', { ...original, title: 'another normalized title outside data' }],
    ];
    for (const [field, value] of mutations) {
      const envelope = structuredClone(retained.envelope);
      Object.assign(envelope, { [field]: value });
      const parts = intakeChunks(envelope);
      expect(parts).toHaveLength(originals.length);
      for (const [index, saved] of originals.entries()) {
        const entry = JSON.parse(saved.before), bytes = parts[index]!;
        entry.entry.body.rawBytesBase64 = bytes.toString('base64');
        const update = (body: { observation: Record<string, unknown> }) => Object.assign(body.observation, {
          byteDigest: sha256(bytes), byteLength: bytes.length, rawBytesBase64: bytes.toString('base64'),
        });
        update(entry.entry.result);
        for (const reply of entry.entry.responses) update(reply.body);
        writeFileSync(saved.file, JSON.stringify(entry));
      }
      const calls = fixture.requests.length;
      const error = await importDataset(directory, source, importOptions).catch(error => error);
      expect(error).toBeInstanceOf(DatasetIntakeCustodyError);
      expect(error.basis).toBe('envelope');
      expect(error.message).toContain(`envelope ${field}`);
      expect(fixture.requests.slice(calls).every(call => call.path === '/v1/catalogue/candidates')).toBe(true);
      for (const saved of originals) writeFileSync(saved.file, saved.before);
    }
    expect(canonical(source)).toBe(before);
  });

  test('retains interrupted multipart intents and resumes the same keys with actual replay replies', async () => {
    const fixture = apiFixture(), directory = root(), original = retainedCase(2, true), source = snapshot([original]);
    let lose = true;
    const api: DatasetApi = { ...fixture.api, async request(method, path, body, key) {
      const response = await fixture.api.request(method, path, body, key);
      if (lose && path === '/v1/sources/intakes'
        && (body as DatasetIntakeRequest).externalId === `${original.externalId}:part:1`)
        throw new Error('socket closed after committed part, before acknowledgement');
      return response;
    } };
    await expect(importDataset(directory, source, { ...options(api), native: false })).rejects.toThrow('response lost');
    const file = readdirSync(directory).find(name => name.startsWith('intakes-'))!;
    const interrupted = intakeJournal(join(directory, file));
    const first = interrupted.commands.find(command => command.coordinate.index === 0)!;
    const uncertain = interrupted.commands.find(command => command.coordinate.index === 1)!;
    expect(first.responses[0]!.status).toBe(201);
    expect(first.result).toBeDefined();
    expect(uncertain.responses).toEqual([]);
    expect(uncertain.result).toBeUndefined();
    expect(interrupted.records[original.key]).toBeUndefined();
    const committed = fixture.receipts.get(uncertain.key)!;
    lose = false;
    const resumed = await importDataset(directory, source, { ...options(api), native: false });
    const receipts = intakeJournal(resumed.intakeReceiptsFile), actual = receipts.records[original.key]!.intakes[1]!.command;
    expect(actual.key).toBe(uncertain.key);
    expect(actual.request).toEqual(uncertain.request);
    expect(actual.result).toEqual({ ...committed, replayed: true });
    expect(actual.responses).toEqual([{ status: 200, body: actual.result }]);
    expect(receipts.records[original.key]!.intakes[0]!.command).toEqual(first);
    const retries = fixture.requests.filter(call => call.key === uncertain.key);
    expect(retries).toHaveLength(9);
    expect(retries.every(call => canonical(call.body) === canonical(uncertain.request))).toBe(true);
    expect(new Set(retries.map(call => call.key)).size).toBe(1);
  });

  test('exports exact refusals and keeps partial requests out of acknowledged record bindings', async () => {
    const fixture = apiFixture(), directory = root(), original = retainedCase(1, false);
    const problem = { status: 403, code: 'source_intake_denied', detail: 'retained owner refusal' };
    const api: DatasetApi = { ...fixture.api, async request(method, path, body, key) {
      if (path === '/v1/sources/intakes') return { status: 403, body: problem };
      return fixture.api.request(method, path, body, key);
    } };
    await expect(importDataset(directory, snapshot([original]), { ...options(api), native: false })).rejects.toThrow('403');
    const file = readdirSync(directory).find(name => name.startsWith('intakes-'))!;
    const receipt = intakeJournal(join(directory, file));
    expect(receipt.commands).toHaveLength(1);
    expect(receipt.commands[0]!.responses).toEqual([{ status: 403, body: problem }]);
    expect(receipt.commands[0]!.result).toBeUndefined();
    expect(receipt.records).toEqual({});
  });

  test('joins intake media, retention, coverage and rights to importer evidence and the acknowledgement', async () => {
    const fixture = apiFixture(), directory = root(), original = retainedCase(1, false), source = snapshot([original]);
    const result = await importDataset(directory, source, { ...options(fixture.api), native: false });
    const command = intakeJournal(result.intakeReceiptsFile).records[original.key]!.intakes[0]!.command;
    const file = requestFile(result.receiptFile, command.label), before = readFileSync(file, 'utf8');
    const mutations = { mediaType: 'text/plain', retention: 'not-retained',
      coverage: { scope: 'unrelated', complete: true, omittedFields: ['summary'] },
      rightsEvidence: { basis: 'permission', note: 'unrelated self-consistent permission' } };
    for (const [field, value] of Object.entries(mutations)) for (const requestChanged of [true, false]) {
      const saved = JSON.parse(before);
      if (requestChanged) saved.entry.body[field] = value;
      saved.entry.result.observation[field] = value;
      for (const reply of saved.entry.responses) reply.body.observation[field] = value;
      writeFileSync(file, JSON.stringify(saved));
      const error = await importDataset(directory, source, { ...options(fixture.api), native: false }).catch(error => error);
      expect(error).toBeInstanceOf(DatasetIntakeCustodyError);
      expect(error.basis).toBe(requestChanged ? 'request' : 'receipt');
      expect(error.message).toContain(field);
      writeFileSync(file, before);
    }
  });

  test('refuses a mismatched retained snapshot file before submitting any public request', async () => {
    const fixture = apiFixture(), directory = root(), original = retainedCase(0, false), source = snapshot([original]);
    freezeSnapshotFile(directory, { ...source, createdAt: 'another frozen file' });
    const error = await importDataset(directory, source, { ...options(fixture.api), native: false }).catch(error => error);
    expect(error).toBeInstanceOf(DatasetIntakeCustodyError);
    expect(error.basis).toBe('snapshot');
    expect(fixture.requests).toEqual([]);
  });

  test('enriches old real-shaped journals without inventing HTTP status or repeating intake', async () => {
    const fixture = apiFixture(), directory = root(), source = snapshot([retainedCase(0, false)]);
    const result = await importDataset(directory, source, { ...options(fixture.api), native: false });
    const receipts = intakeJournal(result.intakeReceiptsFile);
    for (const command of receipts.commands) {
      const file = requestFile(result.receiptFile, command.label), saved = JSON.parse(readFileSync(file, 'utf8'));
      delete saved.entry.intake; delete saved.entry.responses; delete saved.entry.responseStatus;
      writeFileSync(file, JSON.stringify(saved));
    }
    const calls = fixture.requests.length;
    await importDataset(directory, source, { ...options(fixture.api), native: false });
    const replayed = intakeJournal(result.intakeReceiptsFile);
    expect(replayed.unboundCommands).toEqual([]);
    for (const command of replayed.commands) {
      expect(command.responses).toEqual([{ body: command.result! }]);
      expect(command.responses[0]!.status).toBeUndefined();
    }
    expect(fixture.requests.slice(calls).every(call => call.path === '/v1/catalogue/candidates')).toBe(true);
  });

  test('exposes checked full custody to mappers without lending them mutable frozen inputs', async () => {
    const fixture = apiFixture(), directory = root(), original = { ...retainedCase(0, false), native: 'work' as const };
    const source = snapshot([original]), frozen = canonical(source);
    let evidence: DatasetSourceReference | undefined;
    const probe: DatasetNativeMapper = { id: 'fields', revision: 'custody-probe-v1', async map(context) {
      evidence = context.source(original.key);
      expect(evidence.retained!.record).toEqual(original);
      expect(evidence.retained!.intakes[0]!.command.result).toBeDefined();
      evidence.retained!.record.title = 'mutated consumer copy';
      evidence.retained!.intakes[0]!.command.request.externalId = 'mutated consumer copy';
      expect(context.source(original.key).retained!.record.title).toBe(original.title);
      expect(context.source(original.key).retained!.intakes[0]!.command.request.externalId).toBe(original.externalId);
    } };
    const result = await importDataset(directory, source, { ...options(fixture.api), nativeMappers: [probe] });
    expect(evidence).toBeDefined();
    expect(canonical(source)).toBe(frozen);
    expect(intakeJournal(result.intakeReceiptsFile).records[original.key]!.record).toEqual(original);
  });
});

describe('selected native view and original parent intake custody', () => {
  function parentCase(multipart = false) {
    const outside = { ...record('vndb:vn:v99', 'work'), externalId: 'v99' };
    const work = { ...record('vndb:vn:v11', 'work'), externalId: 'v11' };
    const character = { ...record('vndb:character:c1', 'character'), kind: 'character', externalId: 'c1',
      data: { captured: true, ...(multipart ? { text: '字'.repeat(40_000) } : {}) } };
    const source = snapshot([outside, character, work]);
    const appearance = { from: character.key, to: work.key, kind: 'appearance', data: { order: 1 } };
    source.sources[0]!.roots = [outside.key, work.key];
    source.sources[0]!.scope = { complete: true, originalAnchor: outside.key };
    source.sources[0]!.edges = [{ from: work.key, to: character.key, kind: 'character', data: { order: 0 } },
      appearance, structuredClone(appearance),
      { from: character.key, to: outside.key, kind: 'appearance', data: { order: 2 } }];
    source.images = [outside.key, character.key, character.key, work.key].map((key, index) => ({ record: key,
      role: index === 1 ? 'candidate-cover' : 'selected-cover', url: `https://images.example.test/${index}.png`,
      captureRole: 'cover', capture: null, missing: true }));
    source.sources[0]!.images = source.images.map(({ record, role, url }) => ({ record, role, url }));
    sealSnapshot(source);
    return { source, work, outside, character,
      selection: { roots: [work.key], budget: selectionBudget, relatedWorkDepth: 0 } };
  }

  for (const multipart of [false, true]) test(`selection reuses complete ${multipart ? 'multipart' : 'single-part'} parent records, scope and media receipts without rewriting history`, async () => {
    const fixture = apiFixture(), directory = root(), { source, work, character, selection } = parentCase(multipart);
    const frozen = freezeSnapshotFile(directory, source), input = { ...options(fixture.api), native: false };
    const previous = await importDataset(directory, source, input), prior = intakeJournal(previous.intakeReceiptsFile);
    const oldCharacter = prior.records[character.key]!;
    const historical = oldCharacter.intakes.map(part => {
      const file = requestFile(previous.receiptFile, part.command.label), saved = JSON.parse(readFileSync(file, 'utf8'));
      const rights = { basis: 'unknown',
        note: `Frozen local development evidence from ${character.sourceUrl}; raw provider data and images retain their original rights. No redistribution permission is asserted.` };
      saved.entry.body.rightsEvidence = rights;
      saved.entry.result.observation.rightsEvidence = rights;
      delete saved.entry.result.observation.rawBytesBase64;
      delete saved.entry.intake;
      delete saved.entry.responses;
      delete saved.entry.responseStatus;
      const bytes = JSON.stringify(saved);
      writeFileSync(file, bytes);
      return { file, bytes, command: { ...part.command, request: saved.entry.body, result: saved.entry.result,
        responses: [{ body: saved.entry.result }] } };
    });
    const parentJournal = readFileSync(previous.receiptFile, 'utf8'), calls = fixture.requests.length;
    for (let replay = 0; replay < 2; replay++) {
      const selected = await importDataset(directory, source, { ...input, maxRecords: 0, selection });
      const current = intakeJournal(selected.intakeReceiptsFile), retained = current.records[character.key]!;
      expect(selected.records).toBe(2);
      expect(selected.receiptFile).not.toBe(previous.receiptFile);
      expect(selected.selection!.sources[0]!.edges).toEqual([0, 1, 2]);
      expect(retained.envelope).toEqual(oldCharacter.envelope);
      expect(retained.envelope.edges).toEqual(source.sources[0]!.edges.filter(edge => edge.from === character.key));
      expect(retained.envelope.edges).toHaveLength(3);
      expect(retained.envelope.images).toEqual(source.images.slice(1, 3));
      expect(retained.occurrences).toEqual({ edges: ['/sources/0/edges/1', '/sources/0/edges/2', '/sources/0/edges/3'],
        images: ['/images/1', '/images/2'], electedImages: ['/images/2'] });
      expect(retained.intakes.map(part => part.command)).toEqual(historical.map(saved => saved.command));
      for (const command of prior.commands.filter(command => command.coordinate.purpose !== 'record'))
        expect(current.commands.find(item => item.label === command.label)).toEqual(command);
      const scope = current.commands.find(command => command.coordinate.purpose === 'scope')!;
      expect(scope.coordinate.identity.key).toBe(source.sources[0]!.records[0]!.key);
      expect(reconstructIntake([Buffer.from(scope.request.rawBytesBase64, 'base64')])).toEqual({
        format: 'rezics-dataset-scope-v1', snapshot: source.id, digest: source.digest, provider: 'vndb',
        roots: source.sources[0]!.roots, scope: source.sources[0]!.scope,
        intendedRecords: source.sources[0]!.records.map(record => record.key), totalRecords: 3,
      });
      const candidates = current.commands.find(command => command.coordinate.purpose === 'image-candidates')!;
      expect(reconstructIntake([Buffer.from(candidates.request.rawBytesBase64, 'base64')])).toEqual({
        format: 'rezics-dataset-image-candidates-v1', snapshot: source.id, digest: source.digest, provider: 'vndb',
        images: source.sources[0]!.images.map((image, index) => ({ path: `/sources/0/images/${index}`, image })),
      });
      expect(current.records[work.key]!.intakes).toEqual(prior.records[work.key]!.intakes);
      expect(readFileSync(previous.receiptFile, 'utf8')).toBe(parentJournal);
      for (const saved of historical) expect(readFileSync(saved.file, 'utf8')).toBe(saved.bytes);
      expect(readFileSync(join(directory, 'snapshots', source.id, 'snapshot.json'))).toEqual(frozen);
    }
    expect(fixture.requests.slice(calls).filter(request => request.path === '/v1/sources/intakes')).toEqual([]);
  });

  test('retaining outside adjacency does not create native records outside the accepted view', async () => {
    const fixture = apiFixture(), directory = root(), { source, work, outside, character, selection } = parentCase();
    const selected = await importDataset(directory, source, { ...options(fixture.api), maxRecords: 0, selection });
    const native = JSON.parse(readFileSync(selected.receiptFile, 'utf8')).native;
    expect(Object.keys(native).sort()).toEqual([character.key, work.key].sort());
    expect(native[outside.key]).toBeUndefined();
    expect(fixture.nativeWorks).toHaveLength(1);
    const retained = intakeJournal(selected.intakeReceiptsFile).records[character.key]!;
    expect(retained.envelope.edges.at(-1)!.to).toBe(outside.key);
    expect(selected.selection!.sources[0]!.edges).toEqual([0, 1, 2]);
  });

  test('an interrupted selected multipart intake resumes through the parent context without changing its key or bytes', async () => {
    const fixture = apiFixture(), directory = root(), { source, character, selection } = parentCase(true);
    let fail = true;
    const api: DatasetApi = { ...fixture.api, async request(method, path, body, key) {
      const response = await fixture.api.request(method, path, body, key);
      if (fail && path === '/v1/sources/intakes'
        && (body as DatasetIntakeRequest).externalId === 'c1:part:1') throw new Error('closed socket after parent intake commit');
      return response;
    } };
    const input = { ...options(api), native: false };
    await expect(importDataset(directory, source, { ...input, selection })).rejects.toThrow('response lost; rerun to replay the recorded request');
    const file = readdirSync(directory).find(name => name.startsWith('intakes-'))!;
    const interrupted = intakeJournal(join(directory, file));
    const pending = interrupted.commands.find(command => command.request.externalId === 'c1:part:1')!;
    expect(pending.result).toBeUndefined();
    expect(pending.responses).toEqual([]);
    const acknowledged = fixture.receipts.get(pending.key)!;
    fail = false;
    const full = await importDataset(directory, source, input), receipts = intakeJournal(full.intakeReceiptsFile);
    const resumed = receipts.records[character.key]!.intakes[1]!.command;
    expect(resumed.key).toBe(pending.key);
    expect(resumed.request).toEqual(pending.request);
    expect(resumed.result).toEqual({ ...acknowledged, replayed: true });
    expect(resumed.coordinate).toEqual(pending.coordinate);
    expect(receipts.records[character.key]!.envelope.edges).toHaveLength(3);
    const before = fixture.requests.length;
    const otherSubject = await importDataset(directory, source, { ...input, actingSubject: iri(999), selection });
    const other = intakeJournal(otherSubject.intakeReceiptsFile).records[character.key]!.intakes[1]!.command;
    expect(other.key).not.toBe(pending.key);
    expect(fixture.requests.slice(before).some(request => request.path === '/v1/sources/intakes')).toBe(true);
  });
});

describe('offline selection and published producer helpers', () => {
  test('refuses an over-budget closure before any public request and retains its refusal manifest', async () => {
    const fixture = apiFixture(), directory = root();
    const source = snapshot([record('root-work', 'work'), record('character', 'character')]);
    const before = canonical(source);
    const error = await importDataset(directory, source, { ...options(fixture.api),
      selection: { roots: ['root-work'], budget: { ...selectionBudget, maxRecords: 1 } },
    }).catch(error => error);
    expect(error).toBeInstanceOf(DatasetSelectionRefusedError);
    if (!(error instanceof DatasetSelectionRefusedError)) throw error;
    expect(error.manifest.limitations.some(limit => limit.code === 'budget-exceeded')).toBe(true);
    expect(JSON.parse(readFileSync(error.selectionFile, 'utf8'))).toEqual(error.manifest);
    expect(fixture.requests).toHaveLength(0);
    expect(fixture.nativeWorks).toHaveLength(0);
    expect(canonical(source)).toBe(before);
  });

  test('imports the whole accepted closure without a second record cap and preserves earlier bindings and parent bytes', async () => {
    const fixture = apiFixture(), directory = root();
    const other = record('unrelated', 'work'), character = record('character', 'character'), work = record('root-work', 'work');
    const source = snapshot([other, character, work]);
    source.sources[0]!.roots = [other.key, work.key];
    source.sources[0]!.edges = [{ from: work.key, to: character.key, kind: 'character', data: { order: 0 } }];
    const before = canonical(source);
    const prior = await importDataset(directory, source, options(fixture.api));
    const priorBytes = readFileSync(prior.receiptFile, 'utf8'), priorNative = JSON.parse(priorBytes).native;
    const requests = fixture.requests.length;
    const result = await importDataset(directory, source, { ...options(fixture.api), maxRecords: 0,
      selection: { roots: [work.key], budget: selectionBudget, relatedWorkDepth: 0 },
    });
    expect(result.records).toBe(2);
    expect(result.completed).toBe(true);
    expect(result.selection!.parent).toEqual({ id: source.id, digest: source.digest });
    expect(result.selection!.sources[0]!.records).toEqual([1, 2]);
    expect(JSON.parse(readFileSync(result.selectionFile!, 'utf8'))).toEqual(result.selection);
    const native = JSON.parse(readFileSync(result.receiptFile, 'utf8')).native;
    expect(native[work.key].id).toBe(priorNative[work.key].id);
    expect(native[character.key].id).toBe(priorNative[character.key].id);
    expect(readFileSync(prior.receiptFile, 'utf8')).toBe(priorBytes);
    expect(canonical(source)).toBe(before);
    expect(fixture.requests.slice(requests).some(call => call.path === '/v1/work-imports/bulk'
      || call.path === '/v1/semantic/changes/bulk')).toBe(false);
  });

  test('retains field candidates and never-acquired source images without inventing adoption or image occurrences', async () => {
    const fixture = apiFixture(), directory = root(), work = record('field-plan', 'work');
    work.key = `vndb:vn:${work.externalId}`;
    work.data = { alias: 'First alias\nSecond alias', aliases: [{ locale: 'en', name: 'Qualified alias' }],
      rating: 0, unknown: false };
    const source = snapshot([work]);
    source.sources[0]!.images = [{ record: work.key, role: 'cover', url: 'https://images.example.test/never-acquired.png' }];
    sealSnapshot(source);
    const before = canonical(source);
    const result = await importDataset(directory, source, options(fixture.api));
    const plans = JSON.parse(readFileSync(result.fieldPlansFile, 'utf8'));
    expect(plans.parent).toEqual({ id: source.id, digest: source.digest });
    expect(plans.plans[0].fields.some((field: { role: string; disposition: string }) =>
      field.role === 'aliases' && field.disposition === 'candidate')).toBe(true);
    const report = JSON.parse(readFileSync(result.coverageFile, 'utf8'));
    const unqualifiedAlias = report.entries.find((entry: { path: string }) => entry.path === '/data/alias');
    const qualifiedAlias = report.entries.find((entry: { path: string }) => entry.path === '/data/aliases/0/name');
    expect(unqualifiedAlias.disposition.status).toBe('unmapped');
    expect(unqualifiedAlias.disposition.reason).toContain('guessed language');
    expect(qualifiedAlias.disposition.status).toBe('unmapped');
    expect(qualifiedAlias.disposition.reason).toContain('field-adoption-pending');
    expect(qualifiedAlias.disposition.reason).toContain('owner: work-metadata');
    expect(report.entries.find((entry: { path: string }) => entry.path === '/data/rating').disposition.status).toBe('source-only');
    expect(report.entries.find((entry: { path: string }) => entry.path === '/data/unknown').observation).toBe('present');
    expect(report.entries.find((entry: { path: string }) => entry.path === '/title').disposition.status).toBe('mapped');
    expect(report.entries.find((entry: { kind: string }) => entry.kind === 'source-image')).toMatchObject({
      path: '/sources/0/images/0', observation: 'present', acquisition: 'not-acquired',
      disposition: { status: 'unmapped', reason: 'source-image-not-acquired' },
    });
    expect(report.entries.some((entry: { kind: string }) => entry.kind === 'image')).toBe(false);
    expect(result.coverage.pendingAcquisitions).toEqual([{ record: work.key, kind: 'source-image', path: '/sources/0/images/0' }]);
    expect(result.coverage.catalogueReady).toBe(false);
    expect(result.coverage.pendingMappers).toEqual(['fields']);
    expect(fixture.requests.some(call => call.path === '/v1/media/uploads' || call.path.endsWith('/avatar')
      || call.path.endsWith('/conversions') || call.path.endsWith('/proposals'))).toBe(false);
    expect(canonical(source)).toBe(before);
    testDatasetImportCoverage(source, report);
  });

  test('admits only the elected repaired cover and keeps frozen indices through a filtered selection and replay', async () => {
    const fixture = apiFixture(), directory = root(), work = record('elected-work', 'work'), other = record('other-work', 'work');
    const original = coverSnapshot(directory, work), outside = coverSnapshot(directory, other);
    const urls = { cover: 'https://images.example.test/cv1.png', selected: 'https://images.example.test/cv2.png',
      vote: 'https://images.example.test/cv4.png', missing: 'https://images.example.test/screenshot.png' };
    const raw = Buffer.from(JSON.stringify({ id: work.externalId, images: urls }));
    const sourceDigest = putBlob(directory, raw);
    const image = (role: string, field: keyof typeof urls): StoredImage => ({ ...original.image, role, url: urls[field],
      sourceEvidence: { ...original.evidence, recordDigest: sourceDigest, field: `/images/${field}` },
      capture: { ...original.image.capture!, url: urls[field] } });
    const vote = image('candidate-cover', 'vote'), ordinary = image('cover', 'cover'), selected = image('selected-cover', 'selected');
    const parent = original.snapshot;
    parent.sources[0]!.records = [other, work];
    parent.sources[0]!.roots = [other.key, work.key];
    parent.sources[0]!.images = [outside.snapshot.sources[0]!.images[0]!, ...[vote, ordinary, selected].map(value => ({
      record: value.record, role: value.role, url: value.url, sourceEvidence: value.sourceEvidence,
    })), { record: work.key, role: 'screenshot', url: urls.missing }];
    parent.captures = [...outside.snapshot.captures, { ...parent.captures[0]!, digest: sourceDigest, bytes: raw.length }];
    // Legacy capture facts stay frozen. Consumption recovers the evidence and role.
    const legacySelected = { ...selected, sourceEvidence: undefined, captureRole: 'other' as const };
    parent.images = [outside.image, vote, ordinary, legacySelected];
    sealSnapshot(parent);
    const before = canonical(parent);
    const input = { ...options(fixture.api), maxRecords: 0,
      selection: { roots: [work.key], budget: selectionBudget } };
    const first = await importDataset(directory, parent, input);
    const native = JSON.parse(readFileSync(first.receiptFile, 'utf8')).native[work.key].id;
    const selectedReceipt = fixture.currentSelections.get(native);
    const second = await importDataset(directory, parent, input);
    const reservations = fixture.requests.filter(call => call.path === '/v1/media/uploads');
    expect(reservations.length).toBeGreaterThan(0);
    expect(reservations.every(call => (call.body as { importedCover: { image: { captureUrl: string } } })
      .importedCover.image.captureUrl === urls.selected)).toBe(true);
    expect(new Set(reservations.map(call => call.key)).size).toBe(1);
    expect(fixture.currentSelections.get(native)).toBe(selectedReceipt);
    expect(fixture.nativeWorks).toHaveLength(1);
    expect(first.records).toBe(1);
    expect(first.selection!.storedImages).toEqual([1, 2, 3]);
    expect(second.coverResults).toEqual([{ record: sha256(work.key), status: 'imported' }]);
    const report = JSON.parse(readFileSync(second.coverageFile, 'utf8'));
    const at = (path: string) => report.entries.find((entry: { path: string }) => entry.path === path);
    expect(at('/images/3').disposition.status).toBe('mapped');
    expect(at('/images/3').disposition.mapping.receipt.selection).toBe(selectedReceipt);
    expect(at('/images/1').disposition).toEqual({ status: 'source-only', reason: 'unelected-cover-candidate' });
    expect(at('/images/2').disposition.status).toBe('source-only');
    expect(at('/images/0').disposition.status).toBe('unmapped');
    expect(at('/sources/0/images/4')).toMatchObject({ kind: 'source-image', acquisition: 'not-acquired',
      disposition: { status: 'unmapped', reason: 'source-image-not-acquired' } });
    expect(at('/images/4')).toBeUndefined();
    expect(second.coverage.catalogueReady).toBe(false);
    const custody = intakeJournal(second.intakeReceiptsFile);
    const coverIntakes = custody.commands.filter(command => command.coordinate.purpose === 'cover-evidence');
    expect(coverIntakes).toHaveLength(1);
    expect(coverIntakes[0]!.coordinate.occurrences).toEqual({ edges: [], images: ['/images/3'], electedImages: ['/images/3'] });
    expect(coverIntakes[0]!.responses.some(reply => reply.status === 201)).toBe(true);
    expect(coverIntakes[0]!.responses.some(reply => reply.status === 200 && reply.body.replayed === true)).toBe(true);
    expect(canonical(parent)).toBe(before);
    expect(parent.images[3]!.sourceEvidence).toBeUndefined();
    expect(parent.images[3]!.captureRole).toBe('other');
    testDatasetImportCoverage(parent, report);
  });

  test('keeps acknowledged cover replies when a later owner fence refuses replay and preserves an editor selection', async () => {
    const fixture = apiFixture(), directory = root(), work = record('receipt-history', 'work');
    const source = coverSnapshot(directory, work).snapshot;
    const first = await importDataset(directory, source, options(fixture.api));
    const native = fixture.nativeWorks[0]!, originalSelection = fixture.currentSelections.get(native);
    fixture.currentSelections.set(native, uuid(7999));
    const api: DatasetApi = { ...fixture.api, async request(method, path, body, key) {
      if (method === 'PUT' && path.endsWith('/avatar')) return { status: 409, body: { code: 'stale_head' } };
      return fixture.api.request(method, path, body, key);
    } };
    const replay = await importDataset(directory, source, options(api));
    expect(replay.coverResults).toEqual([{ record: sha256(work.key), status: 'pending', step: 'selection',
      reasonCode: 'fence-refused', httpStatus: 409 }]);
    expect(fixture.currentSelections.get(native)).toBe(uuid(7999));
    const requestDirectory = join(directory, 'imports', basename(first.receiptFile, '.json'), 'requests');
    const selection = readdirSync(requestDirectory).filter(name => name.endsWith('.json'))
      .map(name => JSON.parse(readFileSync(join(requestDirectory, name), 'utf8')))
      .find(saved => saved.entry.phase === 'cover-selection').entry;
    expect(selection.body.expectedSelection).toBeNull();
    expect(selection.result).toEqual({ code: 'stale_head' });
    expect(selection.responses.find((reply: { status: number }) => reply.status === 201).body.selection).toBe(originalSelection);
    expect(selection.responses).toContainEqual({ status: 409, body: { code: 'stale_head' } });
    expect(JSON.parse(readFileSync(first.receiptFile, 'utf8')).native[work.key].id).toBe(native);
  });
});

describe('independent public-API dataset import', () => {
  test('duplicate provider-qualified source identities are refused before API writes', async () => {
    const fixture = apiFixture();
    const first = { ...record('one', 'work'), externalId: 'same-provider-identity' };
    const second = { ...first, key: 'another-local-key' };
    await expect(importDataset(root(), snapshot([first, second]), options(fixture.api))).rejects.toThrow('duplicate source identities');
    expect(fixture.requests).toHaveLength(0);
  });

  test('a failed source intake writes a complete occurrence inventory with incomplete transport', async () => {
    const fixture = apiFixture(), directory = root(), source = snapshot([record('allowed'), record('denied')]);
    const api: DatasetApi = { ...fixture.api, async request(method, path, body, key) {
      if (path === '/v1/sources/intakes' && (body as { externalId: string }).externalId === 'denied')
        return { status: 403, body: { code: 'authority_denied' } };
      return fixture.api.request(method, path, body, key);
    } };
    await expect(importDataset(directory, source, options(api))).rejects.toThrow('HTTP 403');
    const file = readdirSync(directory).find(name => name.startsWith('coverage-'))!;
    const coverage = JSON.parse(readFileSync(join(directory, file), 'utf8'));
    expect(coverage.transportCompleted).toBe(false);
    expect(coverage.catalogueReady).toBe(false);
    expect(new Set(coverage.entries.map((entry: { record: string }) => entry.record))).toEqual(new Set(['allowed', 'denied']));
    testDatasetImportCoverage(source, coverage);
  });

  test('a source receipt with another digest never qualifies transport or native adoption', async () => {
    const fixture = apiFixture(), directory = root(), source = snapshot([record('bad-intake-receipt', 'work')]);
    const api: DatasetApi = { ...fixture.api, async request(method, path, body, key) {
      const result = await fixture.api.request(method, path, body, key);
      if (path === '/v1/sources/intakes') (result.body.observation as Record<string, unknown>).byteDigest = '0'.repeat(64);
      return result;
    } };
    await expect(importDataset(directory, source, options(api))).rejects.toThrow('receipt digest');
    expect(fixture.nativeWorks).toHaveLength(0);
    const file = readdirSync(directory).find(name => name.startsWith('coverage-'))!;
    expect(JSON.parse(readFileSync(join(directory, file), 'utf8')).transportCompleted).toBe(false);
  });

  test('reports native user facts separately from completed transport and pending mapper integration', async () => {
    const fixture = apiFixture(), directory = root();
    const source = snapshot([record('known', 'work')]);
    const result = await importDataset(directory, source, options(fixture.api));
    expect(result.completed).toBe(true);
    expect(result.coverage.transportCompleted).toBe(true);
    expect(result.coverage.catalogueReady).toBe(false);
    expect(result.coverage.pendingMappers).toEqual(['fields']);
    const coverage = JSON.parse(readFileSync(result.coverageFile, 'utf8'));
    expect(coverage.entries.find((entry: { path: string }) => entry.path === '/title').disposition.status).toBe('mapped');
    expect(coverage.entries.find((entry: { path: string }) => entry.path === '/data/flags/0').disposition.status).toBe('unmapped');
    expect(coverage.entries.find((entry: { path: string }) => entry.path === '/data/nested/empty').disposition.status).toBe('absent');
    testDatasetImportCoverage(source, coverage);
  });

  test('a later snapshot reuses owner identities and never reports a changed source title as adopted', async () => {
    const fixture = apiFixture(), directory = root(), work = record('vndb:vn:v11', 'work');
    work.externalId = 'v11';
    const first = snapshot([work]), frozen = structuredClone(first);
    const imported = await importDataset(directory, first, options(fixture.api));
    const originalReceipt = readFileSync(imported.receiptFile, 'utf8');
    const native = JSON.parse(originalReceipt).native;
    const changed = structuredClone(first);
    changed.id = 'later-snapshot'; changed.digest = 'b'.repeat(64);
    changed.sources[0]!.records[0]!.title = 'A different source title';
    const result = await importDataset(directory, changed, options(fixture.api));
    expect(JSON.parse(readFileSync(result.receiptFile, 'utf8')).native).toEqual(native);
    expect(readFileSync(imported.receiptFile, 'utf8')).toBe(originalReceipt);
    expect(first).toEqual(frozen);
    expect(fixture.nativeWorks).toHaveLength(1);
    const coverage = JSON.parse(readFileSync(result.coverageFile, 'utf8'));
    expect(coverage.entries.find((entry: { path: string }) => entry.path === '/title').disposition.status).toBe('unmapped');
    testDatasetImportCoverage(changed, coverage);
  });

  test('recovers native identities from another snapshot’s durable bulk receipts after a client crash', async () => {
    const fixture = apiFixture(), directory = root();
    const work = { ...record('vndb:vn:v11', 'work'), externalId: 'v11' };
    const child = { ...record('vndb:character:c22', 'character'), kind: 'character', externalId: 'c22' };
    const source = snapshot([work, child]);
    const first = await importDataset(directory, source, options(fixture.api));
    const checkpoint = JSON.parse(readFileSync(first.receiptFile, 'utf8'));
    const expected = checkpoint.native;
    checkpoint.native = {};
    writeFileSync(first.receiptFile, JSON.stringify(checkpoint));
    source.id = 'after-crash'; source.digest = 'c'.repeat(64);
    const result = await importDataset(directory, source, options(fixture.api));
    const recovered = JSON.parse(readFileSync(result.receiptFile, 'utf8')).native;
    expect(Object.keys(recovered)).toHaveLength(2);
    for (const [key, value] of Object.entries(expected) as [string, DatasetNativeRecord][])
      expect(recovered[key].id).toBe(value.id);
    expect(fixture.nativeWorks).toHaveLength(1);
    expect(fixture.requests.filter(call => call.path === '/v1/semantic/changes/bulk')).toHaveLength(1);
  });

  test('an unresolved older native request blocks another snapshot before new writes', async () => {
    const fixture = apiFixture(), directory = root();
    const source = snapshot([{ ...record('vndb:vn:v11', 'work'), externalId: 'v11' }]);
    const first = await importDataset(directory, source, options(fixture.api));
    const checkpoint = JSON.parse(readFileSync(first.receiptFile, 'utf8'));
    checkpoint.native = {};
    writeFileSync(first.receiptFile, JSON.stringify(checkpoint));
    const requests = join(directory, 'imports', basename(first.receiptFile, '.json'), 'requests');
    for (const file of readdirSync(requests)) {
      if (!file.endsWith('.json')) continue;
      const path = join(requests, file), saved = JSON.parse(readFileSync(path, 'utf8'));
      if (saved.label.startsWith('catalogue-bulk:')) {
        delete saved.entry.result;
        writeFileSync(path, JSON.stringify(saved));
      }
    }
    const previousRequests = fixture.requests.length;
    source.id = 'must-resume-original'; source.digest = 'd'.repeat(64);
    await expect(importDataset(directory, source, options(fixture.api))).rejects.toThrow('Resume retained snapshot');
    expect(fixture.requests.slice(previousRequests).every(call => call.path === '/v1/catalogue/candidates')).toBe(true);
    expect(fixture.nativeWorks).toHaveLength(1);
  });

  test('mapper revisions append journaled public commands, retain source parts and use fresh CAS reads', async () => {
    const fixture = apiFixture(), directory = root();
    const work = record('mapper-work', 'work');
    work.data = { ...work.data, capturedText: 'x'.repeat(110_000) };
    const source = snapshot([work]);
    const supportRequests: { key: string; body: unknown }[] = [];
    let reads = 0, revision = 'map-v1';
    const api: DatasetApi = { ...fixture.api, async request(method, path, body, key) {
      if (method === 'GET' && path.endsWith('/metadata')) {
        reads++;
        return { status: 200, body: { head: iri(8800 + reads) } };
      }
      if (path === '/v1/sources/field-supports') {
        expect(key).toBeDefined(); supportRequests.push({ key: key!, body });
        return { status: 201, body: { support: { profile: 'source-field-support-v1',
          support: iri(9900 + supportRequests.length), state: 'recorded' }, replayed: false } };
      }
      return fixture.api.request(method, path, body, key);
    } };
    const mapper = (): DatasetNativeMapper => ({ id: 'fields', revision, async map(context) {
      const native = context.native.get(work.key)!, evidence = context.source(work.key);
      expect(evidence.intakes.length).toBeGreaterThan(1);
      expect(evidence.intakes.map(part => part.observation)).toEqual(evidence.observations);
      expect(new Set(evidence.intakes.map(part => part.record)).size).toBe(evidence.intakes.length);
      const path = `/v1/works/${native.id.slice(-36)}/metadata`;
      const head = await context.read(path);
      // A mapper normally obtains a conversion from its admitted complete capture.
      // This transport fixture exercises the journal adapter, not conversion/adoption proof.
      const receipt = await context.command('qualified-title', 'POST', '/v1/sources/field-supports', {
        profile: 'source-field-support-attachment-v1', target: native.id,
        slot: 'work-metadata-v1#title:ja', occurrence: null, context: 'default',
        sourceRecord: evidence.intakes[0]!.record, conversion: iri(9800), grain: 'vn', sourceField: 'title',
        sourceOccurrence: null, sourcePointer: '/title', expectedHead: head.head, actingSubject: context.actingSubject,
      });
      context.disposition({ record: work.key, kind: 'field', path: '/title' }, {
        status: 'mapped', reason: 'qualified-source-support', mapping: { target: native.id, readPath: path, receipt },
      });
    } });
    const first = await importDataset(directory, source, { ...options(api), nativeMappers: [mapper()] });
    const firstJournal = readFileSync(first.receiptFile, 'utf8');
    await importDataset(directory, source, { ...options(api), nativeMappers: [mapper()] });
    expect(supportRequests).toHaveLength(1);
    expect(reads).toBe(2);
    revision = 'map-v2';
    const second = await importDataset(directory, source, { ...options(api), nativeMappers: [mapper()] });
    expect(supportRequests).toHaveLength(2);
    expect(supportRequests[1]!.key).not.toBe(supportRequests[0]!.key);
    const requests = join(directory, 'imports', basename(second.receiptFile, '.json'), 'requests');
    const supports = readdirSync(requests).filter(file => file.endsWith('.json'))
      .map(file => JSON.parse(readFileSync(join(requests, file), 'utf8')))
      .filter(saved => saved.label.startsWith('mapping:fields:'));
    expect(supports).toHaveLength(2);
    expect(supports.find(saved => saved.label.includes('map-v1')).entry.body).toEqual(supportRequests[0]!.body);
    expect(JSON.parse(firstJournal).native).toEqual(JSON.parse(readFileSync(second.receiptFile, 'utf8')).native);
    expect(second.coverage.pendingMappers).toEqual([]);
    expect(second.coverage.catalogueReady).toBe(false);
  });

  test('a new snapshot preserves an existing editor or independent source cover selection', async () => {
    const fixture = apiFixture(), directory = root(), work = record('cover-across-snapshots', 'work');
    const source = coverSnapshot(directory, work).snapshot;
    await importDataset(directory, source, options(fixture.api));
    const target = fixture.nativeWorks[0]!;
    fixture.currentSelections.set(target, uuid(7998));
    source.id = 'new-cover-snapshot'; source.sources[0]!.scope.revision = 'newer'; sealSnapshot(source);
    const selections = fixture.requests.filter(call => call.path.endsWith('/avatar')).length;
    const result = await importDataset(directory, source, options(fixture.api));
    expect(fixture.nativeWorks).toHaveLength(1);
    expect(fixture.currentSelections.get(target)).toBe(uuid(7998));
    expect(fixture.requests.filter(call => call.path.endsWith('/avatar'))).toHaveLength(selections);
    expect(result.coverResults[0]).toMatchObject({ status: 'pending', reasonCode: 'fence-refused' });
  });

  test('conflicting retained identities are refused without changing either source journal', async () => {
    const fixture = apiFixture(), directory = root();
    const work = { ...record('vndb:vn:v11', 'work'), externalId: 'v11' };
    const source = snapshot([work]);
    const first = await importDataset(directory, source, options(fixture.api));
    const saved = readFileSync(first.receiptFile, 'utf8');
    const conflict = JSON.parse(saved);
    conflict.native[work.key].id = iri(9876);
    conflict.native[work.key].receipt.work = iri(9876);
    const conflictFile = join(directory, 'imports', sha256('conflicting-prior-receipt') + '.json');
    const other = JSON.stringify(conflict);
    writeFileSync(conflictFile, other);
    const before = fixture.requests.length;
    source.id = 'conflict-refused'; source.digest = 'b'.repeat(64);
    await expect(importDataset(directory, source, options(fixture.api))).rejects.toThrow('Conflicting retained native identities');
    expect(readFileSync(first.receiptFile, 'utf8')).toBe(saved);
    expect(readFileSync(conflictFile, 'utf8')).toBe(other);
    expect(fixture.requests.slice(before).every(call => call.path === '/v1/catalogue/candidates')).toBe(true);
    expect(fixture.nativeWorks).toHaveLength(1);
  });

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
      expect(body.scope.split(' ')).toEqual(expect.arrayContaining(['source:convert', 'source:adopt']));
      return response({ client_id: 'public-dataset-client' }, 201);
    }
    if (url.pathname === '/api/account/installations/public-dataset-client')
      return response({ error: 'not_found' }, 404);
    if (url.pathname === '/api/account/installation-changes') {
      const body = JSON.parse(String(init?.body));
      expect(body).toHaveProperty('change', 'install');
      expect(body.scopes).toEqual(expect.arrayContaining(['source:convert', 'source:adopt']));
      return response({ state: 'active' });
    }
    if (url.pathname === '/api/account/policies')
      return response({ acceptanceRequired: false, policies: [] });
    if (url.pathname === '/api/auth/oauth2/authorize') {
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('scope')?.split(' ')).toEqual(expect.arrayContaining(['source:convert', 'source:adopt']));
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
    if (url.pathname === '/v1/agents') {
      expect(new Headers(init?.headers).get('idempotency-key')).toBe(`dataset-operator:${sha256(userId)}`);
      return response({ agent: iri(7777), state: 'active' }, 201);
    }
    throw new Error(`Unexpected auth route ${url.pathname}`);
  }) as typeof fetch;
  const scope =
    'openid agent:create work:create work:edit work:read source:intake source:read source:convert source:adopt classification:define classification:decide statement:write semantic:read rights:assess';
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

// Frozen audit associations are receipt identities, not a public census or adoption proof.
// Columns: source key, preparation identity, original historical identity.
const frozenNativeIdentities = [
  [
    "vndb:vn:v11",
    "https://rezics.com/id/01a0fd3b-dfbe-70a8-897f-7a8f19cc103f",
    "https://rezics.com/id/01d9b05e-afc0-d869-c745-fad7fcb9db10"
  ],
  [
    "vndb:vn:v11890",
    "https://rezics.com/id/01a0fd3b-f082-7374-b4e3-e74296f4c187",
    "https://rezics.com/id/d36b142b-9288-c1ff-dfe4-135c39323e4d"
  ],
  [
    "vndb:vn:v12243",
    "https://rezics.com/id/01a0fd3b-f338-76a5-a706-a6096165cf9f",
    "https://rezics.com/id/081e0a29-df60-0809-f56d-53edec11312c"
  ],
  [
    "vndb:vn:v12369",
    "https://rezics.com/id/01a0fd3b-f606-7068-8e36-2363b039727f",
    "https://rezics.com/id/4350fb9c-b332-7015-c0c8-07ab08962f21"
  ],
  [
    "vndb:vn:v12463",
    "https://rezics.com/id/01a0fd3b-fbaa-7719-a6f1-a89cd1cd215f",
    "https://rezics.com/id/dec0043f-a0f0-67d2-e6a0-cfdaed83f60e"
  ],
  [
    "vndb:vn:v12706",
    "https://rezics.com/id/01a0fd3b-ff76-74de-9d14-4b3969a96dc0",
    "https://rezics.com/id/59e4d8c8-6239-20b3-c6e6-59ad55b5369b"
  ],
  [
    "vndb:vn:v12779",
    "https://rezics.com/id/01a0fd3c-01dc-7198-ae7c-c2a8675f8bf2",
    "https://rezics.com/id/60389c1d-488b-5518-2a92-de9b10e6f2fc"
  ],
  [
    "vndb:vn:v13288",
    "https://rezics.com/id/01a0fd3c-0487-72a8-aa96-f1d6b12182cb",
    "https://rezics.com/id/7af1c09a-2374-2d71-98e7-bfb0ee6f591f"
  ],
  [
    "vndb:vn:v14408",
    "https://rezics.com/id/01a0fd3c-0f86-758d-95d3-d098bbf5759a",
    "https://rezics.com/id/83c7205d-5a51-77e5-e23b-48847b7f4096"
  ],
  [
    "vndb:vn:v14554",
    "https://rezics.com/id/01a0fd3c-1219-74f8-ac13-c9a49607dda4",
    "https://rezics.com/id/45cd46ab-2522-06cd-72eb-46a5f83ddf2c"
  ],
  [
    "vndb:vn:v14957",
    "https://rezics.com/id/01a0fd3c-14d7-7018-b251-5129198492fc",
    "https://rezics.com/id/6087fc59-1a50-e894-95d9-3781ede87624"
  ],
  [
    "vndb:vn:v15808",
    "https://rezics.com/id/01a0fd3c-1a66-77db-bb23-a7e7dfa25499",
    "https://rezics.com/id/d2a269af-db7e-70a1-1686-dfbd71574cab"
  ],
  [
    "vndb:vn:v16202",
    "https://rezics.com/id/01a0fd3c-1d1b-729e-955f-7f45c6504ff9",
    "https://rezics.com/id/4e1888de-181a-94aa-5a5f-a7108d94990b"
  ],
  [
    "vndb:vn:v18204",
    "https://rezics.com/id/01a0fd3c-2ca4-7649-809e-9a449feb1a22",
    "https://rezics.com/id/ec73caf9-a9ff-2605-39b7-1324f4125017"
  ],
  [
    "vndb:vn:v19119",
    "https://rezics.com/id/01a0fd3c-4146-71fa-aea0-2aea16f4eb5d",
    "https://rezics.com/id/78ba94e6-a1d8-cf37-9207-c55897a58761"
  ],
  [
    "vndb:vn:v21725",
    "https://rezics.com/id/01a0fd3c-43b2-71ee-bd16-49dcab882e4e",
    "https://rezics.com/id/9a6a9efd-35b8-a79b-bcc8-22fc2eb92629"
  ],
  [
    "vndb:vn:v21739",
    "https://rezics.com/id/01a0fd3c-465c-7284-a2e4-00cb742cccb3",
    "https://rezics.com/id/68fef1f0-9c98-2e8b-eae4-d341770a0c73"
  ],
  [
    "vndb:vn:v23380",
    "https://rezics.com/id/01a0fd3c-48f7-70c3-8d57-667def8756ff",
    "https://rezics.com/id/184ac1d3-fc83-2ea7-b993-7a0d684f838a"
  ],
  [
    "vndb:vn:v25235",
    "https://rezics.com/id/01a0fd3c-4e53-7071-a0ac-89575a6b6d1c",
    "https://rezics.com/id/16707a49-b1df-17d6-e64d-7ec318336472"
  ],
  [
    "vndb:vn:v28840",
    "https://rezics.com/id/01a0fd3c-5652-77ca-8d71-8deb496726de",
    "https://rezics.com/id/3953129d-e84c-a9d3-ed39-a5bdfe03e97c"
  ],
  [
    "vndb:vn:v29977",
    "https://rezics.com/id/01a0fd3c-64cb-73e7-8813-1205fe7040d2",
    "https://rezics.com/id/d091c0ad-ba03-9e6d-1ce4-ea0a6dca8275"
  ],
  [
    "vndb:vn:v30132",
    "https://rezics.com/id/01a0fd3c-67dc-7089-8149-d22f57450807",
    "https://rezics.com/id/f5438948-d41f-9403-59ce-7e5dff2faa59"
  ],
  [
    "vndb:vn:v40698",
    "https://rezics.com/id/01a0fd3c-716d-75fb-9d30-59b20a280dc7",
    "https://rezics.com/id/468125d1-dd1e-c239-a852-dd803583a22e"
  ],
  [
    "vndb:vn:v45083",
    "https://rezics.com/id/01a0fd3c-7537-7761-a32d-fc4245c46126",
    "https://rezics.com/id/a6d246fe-4d87-2966-f0ec-ab824496738c"
  ],
  [
    "vndb:vn:v50",
    "https://rezics.com/id/01a0fd3c-91d2-7244-9a4c-f9c900155ac9",
    "https://rezics.com/id/9975a3d3-8d12-2c3d-a2aa-26026baf9681"
  ],
  [
    "vndb:vn:v53550",
    "https://rezics.com/id/01a0fd3c-a342-7391-b81c-b0eee7a30e4c",
    "https://rezics.com/id/cdef2ca8-78a8-ab29-ef28-9aab237c3928"
  ],
  [
    "vndb:vn:v58467",
    "https://rezics.com/id/01a0fd3c-b787-771a-8018-18d342d4394f",
    "https://rezics.com/id/6f2fcf6a-f5f7-d97f-652b-67f86759ed58"
  ],
  [
    "vndb:vn:v64299",
    "https://rezics.com/id/01a0fd3c-dd98-7136-b9c0-308c5b49c956",
    "https://rezics.com/id/b391bfb6-a48a-83d8-6410-67f763cae719"
  ],
  [
    "vndb:vn:v64458",
    "https://rezics.com/id/01a0fd3c-e039-758f-bdf7-cacc0d9d6cae",
    "https://rezics.com/id/90f870bd-4b09-f3c6-7a5e-5c1bef659de9"
  ],
  [
    "vndb:vn:v7555",
    "https://rezics.com/id/01a0fd3d-13d2-71c2-a964-ebcb06e2304c",
    "https://rezics.com/id/adcb6ac3-e9bf-7d2a-040e-ac9b97db3902"
  ],
  [
    "vndb:vn:v7602",
    "https://rezics.com/id/01a0fd3d-16e5-77bd-81d5-9ca579c88458",
    "https://rezics.com/id/36583a03-dc1b-cc6f-730e-50fb4ea1c517"
  ],
  [
    "musicbrainz:recording:00aa1157-b6c8-4dfd-a256-035de7832f45",
    "https://rezics.com/id/01a0fd6a-cf52-73eb-8fe5-39368da274c7",
    "https://rezics.com/id/c4d116ed-9387-67b1-8670-bbb4ec97bc76"
  ],
  [
    "musicbrainz:recording:00e07b56-c0ea-4660-b05d-2a7a8b632cc7",
    "https://rezics.com/id/01a0fd6a-d8d7-7140-8749-655564ff74ba",
    "https://rezics.com/id/435c2945-30cf-3285-bcd2-7a00a80efa41"
  ],
  [
    "musicbrainz:recording:01ac6750-0c55-4f3e-9cc1-8c439dd55f65",
    "https://rezics.com/id/01a0fd6a-df55-74d3-89fd-b095046b5fb5",
    "https://rezics.com/id/8e1e0cbd-c2c3-e0d9-95fd-c4d88bbd98a1"
  ],
  [
    "musicbrainz:recording:020997e6-d39c-4419-8377-bfb9d859f60e",
    "https://rezics.com/id/01a0fd6a-e4f6-77d0-8d64-78737c42db82",
    "https://rezics.com/id/1be62202-7485-1d05-a5a5-307f7a463995"
  ],
  [
    "musicbrainz:recording:0435f4f0-e507-42db-9f17-90578e357062",
    "https://rezics.com/id/01a0fd6a-eb20-749d-b995-51462f4d9e5e",
    "https://rezics.com/id/e506b57b-ac62-5d13-3262-b100b0b34e53"
  ],
  [
    "musicbrainz:recording:0467383c-a704-47d4-9e59-150455f85bcf",
    "https://rezics.com/id/01a0fd6a-f09e-741b-b1fb-8a914dafe3bb",
    "https://rezics.com/id/6b96f7d5-007a-3ea7-2d76-091e38c8c9b4"
  ],
  [
    "musicbrainz:recording:050d70dd-5c5e-4c8e-b42e-58154b1a7b86",
    "https://rezics.com/id/01a0fd6a-f527-742f-9b08-fe6ae9424430",
    "https://rezics.com/id/9bd99c89-c0ef-63e5-85fa-c87216b27d3a"
  ],
  [
    "musicbrainz:recording:053d552a-1718-42d0-82e8-2fdcc2d5b30e",
    "https://rezics.com/id/01a0fd6a-f907-74b7-b362-b4724b1539a6",
    "https://rezics.com/id/cc62f002-dd91-a8e1-cc1f-5755db61b781"
  ],
  [
    "musicbrainz:recording:05833d73-e1e0-4d69-a00b-a586f8ffb3b6",
    "https://rezics.com/id/01a0fd6a-fccf-7019-a0ed-e94c28618a5b",
    "https://rezics.com/id/740b40ed-389d-fc91-cdaa-c5891fd2815b"
  ],
  [
    "musicbrainz:recording:061b67f4-4bda-43d0-9377-da36c5a34d5b",
    "https://rezics.com/id/01a0fd6b-01bc-717b-9351-79730d21d340",
    "https://rezics.com/id/2e94ce18-1d92-4406-673e-1e23c3f4f7f7"
  ],
  [
    "musicbrainz:recording:079ef961-0dea-41ee-9d77-0c3a92d7c5d9",
    "https://rezics.com/id/01a0fd6b-063c-7051-a21d-a0e10478ef87",
    "https://rezics.com/id/fd0b7950-daed-e5c0-ddbe-f7d3d7e3217b"
  ],
  [
    "musicbrainz:recording:07c9f1a8-c11f-460e-b8ae-99081f6f6094",
    "https://rezics.com/id/01a0fd6b-0af2-7075-a1a0-f1f7bd8fee17",
    "https://rezics.com/id/8cd65da2-5f3c-17ca-0df0-7347249b2d24"
  ],
  [
    "musicbrainz:recording:0806803d-6514-4b1b-bdb0-e52f743ee225",
    "https://rezics.com/id/01a0fd6b-1053-7455-b285-e94222ec2264",
    "https://rezics.com/id/d5ade6e4-1eb5-e746-de90-f4268fc261e4"
  ],
  [
    "musicbrainz:recording:091b7064-fdcc-4fb1-9f25-d2c83971cf57",
    "https://rezics.com/id/01a0fd6b-150c-7351-8afe-8d1879b9dafd",
    "https://rezics.com/id/14dd36e6-9fcf-7588-6fb3-fee91673f2c6"
  ],
  [
    "musicbrainz:recording:0997cbfc-c6a3-4bb4-8d36-bf2d9307bb87",
    "https://rezics.com/id/01a0fd6b-195f-767f-8595-e0842e8889d5",
    "https://rezics.com/id/abb82ba4-96a3-57ee-2f2c-bee29a497ef4"
  ],
  [
    "musicbrainz:recording:0a7131ea-428f-4426-a3c2-4150ea630ada",
    "https://rezics.com/id/01a0fd6b-1f60-741b-8116-b15be69a7c07",
    "https://rezics.com/id/6b11a1df-5e06-c45f-a55a-a9d9a087d6af"
  ],
  [
    "musicbrainz:recording:0ad0a979-8283-4012-a6ac-3b0e7870e154",
    "https://rezics.com/id/01a0fd6b-2445-715b-a0bf-116ea46d6fa2",
    "https://rezics.com/id/5f074e11-6936-a954-1d16-1c5d27665f88"
  ],
  [
    "musicbrainz:recording:0b485349-c6fc-481f-920e-d6b79f715180",
    "https://rezics.com/id/01a0fd6b-2c0b-7351-8a45-f0cddfb3b210",
    "https://rezics.com/id/85c6ec97-4c17-4035-a09b-4aadbd31b92b"
  ],
  [
    "musicbrainz:recording:0b4f2998-c58a-49a0-b4e0-abd8d1736221",
    "https://rezics.com/id/01a0fd6b-32f6-77a6-b10e-201722563c81",
    "https://rezics.com/id/7900d020-d5e5-7b87-27b4-8e7a5b96a9f9"
  ],
  [
    "musicbrainz:recording:0bc688b5-7fda-4df3-a763-63340bfedc57",
    "https://rezics.com/id/01a0fd6b-3aae-7352-acb7-01f9f70594ce",
    "https://rezics.com/id/b24504f0-1ff5-eb8b-6434-070d39e983ab"
  ],
  [
    "musicbrainz:recording:0d398c47-19f4-4284-843b-de029dff4a49",
    "https://rezics.com/id/01a0fd6b-3e96-7086-aa49-463a5c9ebba6",
    "https://rezics.com/id/23644428-f59e-1803-ef01-4c41d67099a0"
  ],
  [
    "musicbrainz:recording:0df811ab-6785-4e56-83d7-bca35a5023de",
    "https://rezics.com/id/01a0fd6b-4436-7596-8090-a8e146c3f28e",
    "https://rezics.com/id/e15931f8-a87c-4d6b-d37b-f3ad3b1cf0c4"
  ],
  [
    "musicbrainz:recording:0e4c4d14-31ac-41ab-ae93-322e15cc14c7",
    "https://rezics.com/id/01a0fd6b-4b45-7014-9211-f775090c4ee4",
    "https://rezics.com/id/2f83ff9f-4f7b-eaac-f3f2-57030e3bfff7"
  ],
  [
    "musicbrainz:recording:0e5d3279-7925-40de-a30d-b64622203451",
    "https://rezics.com/id/01a0fd6b-50f8-74ec-812b-3e1f2f192b03",
    "https://rezics.com/id/537db7aa-256c-b94c-f400-5937262f74a4"
  ],
  [
    "musicbrainz:recording:0ecdebff-6bc0-4b31-9b17-ca7efa5aa39e",
    "https://rezics.com/id/01a0fd6b-55fc-758f-9356-3e981d52993a",
    "https://rezics.com/id/fdf99059-c0fc-27d6-0c6b-e48c6eba497c"
  ],
  [
    "musicbrainz:recording:0eeab2d1-0c57-4853-b249-068f9f6eca93",
    "https://rezics.com/id/01a0fd6b-5a27-7489-99ed-b4c5c37f3ec2",
    "https://rezics.com/id/15f2e51f-33a3-375f-11a1-f965f846dd72"
  ],
  [
    "musicbrainz:recording:0faedb9a-892a-4e62-80f0-c378c0d53b77",
    "https://rezics.com/id/01a0fd6b-5e5e-7205-8d56-c7be56592627",
    "https://rezics.com/id/da056bd4-fb03-dae7-4333-04db1a6862bd"
  ],
  [
    "musicbrainz:recording:0fcbd5fa-c6da-4b69-b9f1-f08747e86c22",
    "https://rezics.com/id/01a0fd6b-61f1-75a1-b8dc-05cfc93f6b25",
    "https://rezics.com/id/17fc6907-ed13-6670-20db-c7cd97945e1a"
  ],
  [
    "musicbrainz:recording:10acbb87-d5f1-432e-bdb4-db0d93d223b0",
    "https://rezics.com/id/01a0fd6b-65b6-73e9-a647-4fe3a4aedcf2",
    "https://rezics.com/id/99e3f604-f89c-d304-689d-c007226e52e9"
  ],
  [
    "musicbrainz:recording:10edf542-c338-4411-bfc2-de13c3284dde",
    "https://rezics.com/id/01a0fd6b-68e6-751c-a32a-1eeb441af930",
    "https://rezics.com/id/1a39bc86-b854-d2c9-5d89-4861e2c173ec"
  ],
  [
    "musicbrainz:release-group:055be730-dcad-31bf-b550-45ba9c202aa3",
    "https://rezics.com/id/01a0fdb1-2d73-748d-b0f3-45840365cad2",
    "https://rezics.com/id/77913548-8fa2-1088-d511-4179c3da65fb"
  ],
  [
    "musicbrainz:release-group:7c8f2d45-d764-347a-9ab9-0aa771a3447d",
    "https://rezics.com/id/01a0fdb1-30e7-7222-b23f-5f4e4055cad9",
    "https://rezics.com/id/42861943-ef5f-b443-ef87-04824c013b84"
  ],
  [
    "musicbrainz:release-group:f2026101-945b-3d05-9ef4-aa718fc3feef",
    "https://rezics.com/id/01a0fdb1-3469-7059-a50d-58c773cbbce3",
    "https://rezics.com/id/77aa1a6b-0e53-5b04-4055-94c5bc5a1d77"
  ],
  [
    "musicbrainz:work:008868d1-3ef6-3503-b652-c8cc5e86455c",
    "https://rezics.com/id/01a0fdb1-3819-74b9-a2b1-f2d0e648ab2c",
    "https://rezics.com/id/4d8c65fd-3c54-fea5-5fbf-2529cb29ed74"
  ],
  [
    "musicbrainz:work:009f3ce8-feea-4f65-bb2b-7e024000d521",
    "https://rezics.com/id/01a0fdb1-3c4d-74ef-a7bf-d04a9a02dfbc",
    "https://rezics.com/id/0d29dd3b-ba3e-9ee5-7d08-fad4aca36fec"
  ],
  [
    "musicbrainz:work:01160050-85a9-4fdd-a9d9-be3142a14bed",
    "https://rezics.com/id/01a0fdb1-439e-758f-a0bf-2a292f201b47",
    "https://rezics.com/id/2aed4850-8428-a016-50c0-e36a9459bffb"
  ],
  [
    "musicbrainz:work:02546b89-84ca-4a48-8fce-226a5792e1bd",
    "https://rezics.com/id/01a0fdb1-4b43-7647-afb1-4abd246a327f",
    "https://rezics.com/id/51d52663-4dd8-15dc-b762-2833e327368c"
  ],
  [
    "musicbrainz:work:0288f511-e191-3f26-9b86-8a82acd01b0c",
    "https://rezics.com/id/01a0fdb1-5174-7524-bfea-4aa69801226b",
    "https://rezics.com/id/41e254ca-8f10-f70e-9b1c-2ec734316e12"
  ],
  [
    "musicbrainz:work:032c5a23-cfde-33e9-b501-0321feb88f63",
    "https://rezics.com/id/01a0fdb1-5845-75c1-ba3c-5a47600626af",
    "https://rezics.com/id/001a8fac-8f6d-710a-4c1d-a4d09df7969d"
  ],
  [
    "musicbrainz:work:03508155-616a-4e53-affd-ea78b0f97cdd",
    "https://rezics.com/id/01a0fdb1-5b4d-720c-8a04-7675711667c2",
    "https://rezics.com/id/53fda7dc-4222-d7a2-a6ce-cd39d8d9d121"
  ],
  [
    "musicbrainz:work:03b53d70-274c-473d-aef4-b8b7468b16e5",
    "https://rezics.com/id/01a0fdb1-5e6e-73ac-8968-5bb2fd16effe",
    "https://rezics.com/id/e5d01672-3c45-15ba-6784-4b92ea5736f4"
  ],
  [
    "musicbrainz:work:045ba111-5273-4fc0-9063-5cf8f81406bb",
    "https://rezics.com/id/01a0fdb1-6109-72f9-bb46-2a3376c4b584",
    "https://rezics.com/id/3907124f-069a-45fd-447b-158d651d7b27"
  ],
  [
    "musicbrainz:work:049d64a7-3675-4b15-acd9-25c8e3a9ac79",
    "https://rezics.com/id/01a0fdb1-63b2-776d-8687-7ee5c6530cbc",
    "https://rezics.com/id/2a8ed247-f148-8931-ed0c-891c57910bc6"
  ],
  [
    "musicbrainz:work:04ceae91-fa94-4af0-9ad4-406c4c59a906",
    "https://rezics.com/id/01a0fdb1-665d-7509-8dd8-e8d5f09f3888",
    "https://rezics.com/id/b0cbeecd-0170-d9eb-4061-455e75e3dd91"
  ],
  [
    "musicbrainz:work:056b839a-70ae-3a65-a805-c70e2dd4b3de",
    "https://rezics.com/id/01a0fdb1-69b2-7717-a425-9615fbe6a7bf",
    "https://rezics.com/id/db954aee-a16d-3729-28ca-d5091b20eb85"
  ],
  [
    "musicbrainz:work:062fe63b-b692-49f8-ab11-ede0c37883aa",
    "https://rezics.com/id/01a0fdb1-6c5f-7049-97cb-e339c4352d8c",
    "https://rezics.com/id/d305473b-89ef-fd6d-8184-ad45682f6af7"
  ],
  [
    "musicbrainz:work:067c395d-0053-43e3-bb24-2742da76486e",
    "https://rezics.com/id/01a0fdb1-6ed2-74a9-a181-4ad8cf71dcc7",
    "https://rezics.com/id/51b1ccbd-013d-c379-76ed-5d2e7b41cc0c"
  ],
  [
    "musicbrainz:work:06d7de06-ebd5-4442-91bc-b152df84a8fc",
    "https://rezics.com/id/01a0fdb1-71a9-7531-9bd0-5c0a28a64fad",
    "https://rezics.com/id/206f19ce-8bc4-6d3b-0dde-dd4c56dd97c9"
  ],
  [
    "musicbrainz:work:0719a844-7338-3428-b286-b18f4e156ada",
    "https://rezics.com/id/01a0fdb1-74dc-7128-bf0b-f433a9580183",
    "https://rezics.com/id/95577125-9f80-46ec-cb96-d62dadc0c600"
  ],
  [
    "bangumi:subject:1014",
    "https://rezics.com/id/01a0fd4b-b3e3-71e2-8aab-1f0f8697d97a",
    "https://rezics.com/id/ffb7d8bd-0e5c-05bb-66a8-ba90b8ac4b51"
  ],
  [
    "bangumi:subject:101992",
    "https://rezics.com/id/01a0fd4b-c30c-76e9-9b66-0d534517e188",
    "https://rezics.com/id/67789507-c14b-157a-40ee-71e06ba34380"
  ],
  [
    "bangumi:subject:103169",
    "https://rezics.com/id/01a0fd4b-d131-717c-9a57-ba29e5e98615",
    "https://rezics.com/id/8c39bfde-19d8-c383-624b-a349b150adb5"
  ],
  [
    "bangumi:subject:103796",
    "https://rezics.com/id/01a0fd4b-d70d-75de-b986-9aad626c35c8",
    "https://rezics.com/id/5a616b77-638b-26ef-9e6d-bf662866e1ad"
  ],
  [
    "bangumi:subject:103820",
    "https://rezics.com/id/01a0fd4b-dc9f-7550-a3de-352d61bafe84",
    "https://rezics.com/id/c42de6af-1f62-3ffb-9dbf-2d770a47d5b1"
  ],
  [
    "bangumi:subject:104185",
    "https://rezics.com/id/01a0fd4b-e225-75f0-82c8-9771e9e8b008",
    "https://rezics.com/id/d3b056cb-5c59-f3c2-9567-fedf307b1d8e"
  ],
  [
    "bangumi:subject:105404",
    "https://rezics.com/id/01a0fd4b-e8fa-700e-8d81-e92e7a894703",
    "https://rezics.com/id/542d4532-da83-aa3f-b139-a0f419ad92a7"
  ],
  [
    "bangumi:subject:10716",
    "https://rezics.com/id/01a0fd4b-f46d-767c-8d49-0d265afa4c87",
    "https://rezics.com/id/c974691a-1b27-d973-59d4-15d69ca814e7"
  ],
  [
    "bangumi:subject:10717",
    "https://rezics.com/id/01a0fd4b-fa50-7220-a063-e9bc1c0a7dc4",
    "https://rezics.com/id/d4b025a2-3a01-4d76-f1bb-f48d7086bd1c"
  ],
  [
    "bangumi:subject:109104",
    "https://rezics.com/id/01a0fd4c-01c4-700e-aad6-eec0aa82d14e",
    "https://rezics.com/id/c7985e03-33b1-6701-36b6-9c75d429ee4a"
  ],
  [
    "bangumi:subject:109276",
    "https://rezics.com/id/01a0fd4c-08ff-7433-a458-07c26bca4391",
    "https://rezics.com/id/39f4f200-0071-87e4-d5c5-9ee89760251f"
  ],
  [
    "bangumi:subject:109277",
    "https://rezics.com/id/01a0fd4c-107e-72ec-aa74-f6c0520a2728",
    "https://rezics.com/id/f3cc113f-5010-616d-70c7-9c1ac52fb70a"
  ],
  [
    "bangumi:subject:110526",
    "https://rezics.com/id/01a0fd4c-1f65-70d4-a38d-fe017f64a199",
    "https://rezics.com/id/456aa6ee-f845-50c3-bc23-cffaf0cbcc2b"
  ],
  [
    "bangumi:subject:112155",
    "https://rezics.com/id/01a0fd4c-354c-731e-af5e-cc1967726f25",
    "https://rezics.com/id/c7579ba9-81b5-1244-3bc1-14886db4694d"
  ],
  [
    "bangumi:subject:11220",
    "https://rezics.com/id/01a0fd4c-3cd6-7130-854f-3cfeac891be7",
    "https://rezics.com/id/ee4f2557-6880-fd70-d4c1-d583c935a9ba"
  ],
  [
    "bangumi:subject:11232",
    "https://rezics.com/id/01a0fd4c-441f-77d4-9091-89a292ef26f0",
    "https://rezics.com/id/d406de5d-e5da-ad3e-8602-ae0e033e7018"
  ],
  [
    "bangumi:subject:112553",
    "https://rezics.com/id/01a0fd4c-50e6-70fd-a046-1a9dd0de8101",
    "https://rezics.com/id/97630b89-3ab3-2ca6-41f5-6f2f4b7891dc"
  ],
  [
    "bangumi:subject:11528",
    "https://rezics.com/id/01a0fd4c-58d2-7405-97d2-c7fbc01a2422",
    "https://rezics.com/id/8cc87bf4-7398-32dd-2b6d-ff5f968c26a7"
  ],
  [
    "bangumi:subject:115589",
    "https://rezics.com/id/01a0fd4c-604c-75c5-bdf5-841ca4b4c02e",
    "https://rezics.com/id/be93ad9a-a6a0-833c-ade7-137e85406b2d"
  ],
  [
    "bangumi:subject:11648",
    "https://rezics.com/id/01a0fd4c-6801-70e3-8f71-ac4d0edda12f",
    "https://rezics.com/id/a1e96387-916c-0362-1e00-14759e31c15e"
  ],
  [
    "bangumi:subject:119186",
    "https://rezics.com/id/01a0fd4c-6f97-7016-9a14-57c685490021",
    "https://rezics.com/id/3894a02f-4013-55d4-db0d-8a61efb023db"
  ],
  [
    "bangumi:subject:119526",
    "https://rezics.com/id/01a0fd4c-827e-75a5-aab5-c1c58c532120",
    "https://rezics.com/id/62017cd3-2dbd-c7c9-680d-ab3658014f8c"
  ],
  [
    "bangumi:subject:121178",
    "https://rezics.com/id/01a0fd4c-8bc9-7561-9cd2-9c4cedbcbe9f",
    "https://rezics.com/id/35736cc5-e9e2-9e46-1573-58926f5f9ea3"
  ],
  [
    "bangumi:subject:121179",
    "https://rezics.com/id/01a0fd4c-92ba-7459-8195-c552a89f5ea8",
    "https://rezics.com/id/c70a1104-a669-d481-0eb5-093c0f3ca810"
  ],
  [
    "bangumi:subject:121181",
    "https://rezics.com/id/01a0fd4c-9d64-721b-925e-350163f3ffb2",
    "https://rezics.com/id/45b9d331-c44d-8e03-ce0f-73bfeb64012f"
  ],
  [
    "bangumi:subject:123866",
    "https://rezics.com/id/01a0fd4f-ede9-735e-acf3-49e137aa94a4",
    "https://rezics.com/id/d2b66518-da0c-e405-4e8f-405e5d34e29c"
  ],
  [
    "bangumi:subject:123868",
    "https://rezics.com/id/01a0fd4f-fcec-70c0-ad08-19b1de5e1094",
    "https://rezics.com/id/21866520-40f3-f590-8d23-92cf86de476d"
  ],
  [
    "bangumi:subject:123869",
    "https://rezics.com/id/01a0fd50-1378-768d-a693-d1f7d04bdf06",
    "https://rezics.com/id/925e3128-a989-6ce7-04be-f9f9d03dac4d"
  ],
  [
    "bangumi:subject:123976",
    "https://rezics.com/id/01a0fd50-9f00-70bf-a3b8-c98d270a4c03",
    "https://rezics.com/id/cfdd9091-f08a-f3c9-c5a0-b0e57aaa3495"
  ],
  [
    "bangumi:subject:123977",
    "https://rezics.com/id/01a0fd50-b109-7345-9475-89b553d9a248",
    "https://rezics.com/id/887fd02e-44c4-f1f9-9333-a804b090d827"
  ],
  [
    "bangumi:subject:123978",
    "https://rezics.com/id/01a0fd50-c968-7356-a3ce-d4f82f36509b",
    "https://rezics.com/id/f268dd76-efa2-ad40-308a-e8148dc2b496"
  ],
  [
    "bangumi:subject:123979",
    "https://rezics.com/id/01a0fd68-6445-748d-bf4e-709488cfe945",
    "https://rezics.com/id/0065ba5d-aab8-1e67-5fcf-dc1ab056215d"
  ],
  [
    "bangumi:subject:975",
    "https://rezics.com/id/01a0fd8e-6241-75a2-abde-8c9e76edb7b6",
    "https://rezics.com/id/3a247546-9e73-0c44-1580-0d8b3b3fe511"
  ]
] as const;

test('preserves all 113 frozen source/native identities at each retained epoch without reimport or native creation', async () => {
  for (const era of [1, 2] as const) {
    const fixture = apiFixture(), directory = root(), session = options(fixture.api);
    const records: DatasetRecord[] = frozenNativeIdentities.map(([key]) => {
      const [provider, kind, externalId] = key.split(':');
      return { ...record(key, 'work'), provider: provider as DatasetRecord['provider'], kind: kind!, externalId: externalId!,
        title: 'Later observed title ' + key, data: { observed: true, count: 0 } };
    });
    const source = snapshot(records);
    source.id = 'later-frozen-shape'; source.digest = 'f'.repeat(64);
    source.sources = (['vndb', 'bangumi', 'musicbrainz'] as const).flatMap(provider => {
      const members = records.filter(record => record.provider === provider);
      return members.length ? [{ provider, roots: members.map(record => record.key), records: members,
        edges: [], images: [], scope: { complete: true } }] : [];
    });
    const frozenSource = structuredClone(source);
    mkdirSync(join(directory, 'imports'));
    const previous: string[] = [];
    for (const column of [1, 2] as const) {
      const filename = join(directory, 'imports', sha256('retained-epoch-' + column) + '.json');
      const native = Object.fromEntries(frozenNativeIdentities.map(row => [row[0], {
        id: row[column], kind: 'work', receipt: { work: row[column], evidence: 'retained-receipt-only' }, urls: [],
      }]));
      const journal = { format: 'rezics-dataset-import-v1', snapshot: 'retained-epoch-' + column,
        digest: String(column).repeat(64), mainOrigin: session.mainOrigin, actingSubject: session.actingSubject,
        dataEpoch: column === era ? 'epoch-1' : 'a-different-retained-epoch', entries: {}, native,
        limitations: [], completed: true };
      const bytes = JSON.stringify(journal); previous.push(bytes); writeFileSync(filename, bytes);
    }
    const result = await importDataset(directory, source, session);
    const actual = JSON.parse(readFileSync(result.receiptFile, 'utf8')).native;
    expect(Object.keys(actual)).toHaveLength(113);
    for (const row of frozenNativeIdentities) {
      expect(actual[row[0]].id).toBe(row[era]);
      expect(actual[row[0]].receipt).toEqual({ work: row[era], evidence: 'retained-receipt-only' });
    }
    for (const column of [1, 2] as const) {
      const filename = join(directory, 'imports', sha256('retained-epoch-' + column) + '.json');
      expect(readFileSync(filename, 'utf8')).toBe(previous[column - 1]!);
    }
    expect(fixture.requests.some(call => ['/v1/works', '/v1/work-imports/bulk', '/v1/semantic/changes/bulk'].includes(call.path))).toBe(false);
    expect(source).toEqual(frozenSource);
    expect(result.coverage.catalogueReady).toBe(false);
    expect(result.coverage.counts.mapped).toBe(0);
  }
}, 15_000); // Two complete retained epochs write and verify 226 exact intake journals.

describe('retained field adoption through the actual importer', () => {
  function setup(settings: { multipart?: boolean; language?: string | null; human?: boolean;
    lostNativeReplies?: boolean; lostSupportReplies?: boolean; supportRefusal?: boolean; corruptBinding?: boolean; corruptSupport?: boolean;
    withdrawn?: boolean; semantic?: boolean; editorDuringSupportRead?: boolean;
    duplicateSummary?: 'same' | 'different-value' | 'different-language' } = {}) {
    const fixture = apiFixture(), directory = root();
    const work: DatasetRecord = { key: 'vndb:vn:v11', provider: 'vndb', kind: 'vn', externalId: 'v11',
      title: 'Fate/stay night', language: 'ja', native: 'work', sourceUrl: 'https://vndb.org/v11',
      data: settings.semantic ? {} : { description: settings.multipart ? '行\n'.repeat(40_000) : '原文のまま\nSecond paragraph.',
        ...(Object.hasOwn(settings, 'language') ? { description_language: settings.language } : {}) } };
    const person: DatasetRecord = { key: 'vndb:staff:s1', provider: 'vndb', kind: 'staff', externalId: 's1',
      title: '原名', language: 'ja', native: 'person', sourceUrl: 'https://vndb.org/s1', data: { country: '日本' } };
    if (settings.duplicateSummary) {
      Object.assign(work, { key: 'bangumi:subject:1014', provider: 'bangumi', kind: 'subject', externalId: '1014',
        sourceUrl: 'https://bgm.tv/subject/1014', data: { summary: 'Exact retained synopsis.', summary_language: 'zh-Hans',
          api_subject: { summary: settings.duplicateSummary === 'different-value' ? 'Another retained synopsis.' : 'Exact retained synopsis.',
            summary_language: settings.duplicateSummary === 'different-language' ? 'zh-hans' : 'zh-Hans' } } });
    }
    const source = snapshot(settings.semantic ? [work, person] : [work]);
    source.sources[0]!.provider = work.provider;
    const file = join(directory, 'snapshots', source.id, 'snapshot.json');
    mkdirSync(dirname(file), { recursive: true });
    const frozen = JSON.stringify(source, null, 2); writeFileSync(file, frozen);
    const calls: { method: string; path: string; body: unknown; key?: string }[] = [];
    const observations = new Map<string, StagedSourceObservation>(), replies = new Map<string, Record<string, unknown>>();
    const supports = new Map<string, Record<string, unknown>>(), semantic = new Map<string, Record<string, unknown>>();
    let serial = 900_100, lost = 0, control: Record<string, unknown> | undefined;
    const freshId = () => iri(serial++), receiptId = (key: string) => `urn:rezics:receipt:${sha256(key)}`;
    const api: DatasetApi = { ...fixture.api, async request(method, path, body, key) {
      calls.push(structuredClone({ method, path, body, key }));
      if (method === 'GET' && path.includes('/fields/synopsis/control')) {
        const target = `https://rezics.com/id/${path.split('/')[3]}`;
        control ??= { profile: 'work-editorial-field-control-v1', work: target, field: 'synopsis', slot: synopsisSlot(target),
          workHead: freshId(), contentHead: settings.human ? freshId() : null, controlHead: settings.human ? freshId() : null,
          controlEpoch: settings.human ? '3' : '0', protectionHead: null,
          mode: settings.human ? 'human-controlled' : 'unestablished', value: settings.human ? 'Editor choice' : null,
          rightsStatus: null };
        return { status: 200, body: structuredClone(control) };
      }
      if (method === 'GET' && path.startsWith('/v1/semantic/resources/')) {
        const current = semantic.get(path.split('/')[4]!.split('?')[0]!);
        return current ? { status: 200, body: structuredClone(current) } : { status: 404, body: { code: 'semantic_unavailable' } };
      }
      if (method === 'GET' && path.startsWith('/v1/sources/field-supports/')) {
        const support = supports.get(path.split('/').at(-1)!);
        if (settings.editorDuringSupportRead) control = { ...control, workHead: freshId(), contentHead: freshId(),
          controlHead: freshId(), controlEpoch: '2', mode: 'human-controlled', value: 'Concurrent editor choice' };
        return support ? { status: 200, body: { ...structuredClone(support),
          ...(settings.withdrawn ? { state: 'withdrawn', withdrawal: { reason: 'independent withdrawal' } } : {}) } }
          : { status: 404, body: { code: 'source_support_unavailable' } };
      }
      const isConversion = method === 'POST' && path.endsWith('/conversions');
      const isSynopsis = method === 'POST' && path.endsWith('/fields/synopsis/control');
      const loseReply = isSynopsis && settings.lostNativeReplies || path === '/v1/sources/field-supports' && settings.lostSupportReplies;
      if (isConversion || isSynopsis || path === '/v1/semantic/changes' || path === '/v1/sources/field-supports') {
        expect(key).toBeDefined();
        const saved = replies.get(key!);
        if (saved) {
          if (loseReply && lost++ < 8) throw new Error('reply lost after owner commit');
          return { status: 200, body: { ...structuredClone(saved), replayed: true } };
        }
        let result: Record<string, unknown>;
        if (isConversion) {
          const input = body as RetainedConversionRequest;
          expect(input.profile).toBe('source-retained-record-conversion-v1');
          const actual = input.retained.intakes.map(part => observations.get(part.observation)!);
          const verified = verifyRetainedRecord(input, actual);
          expect(input.retained.snapshot.fileSha256).toBe(sha256(Buffer.from(frozen)));
          const { record: _record, ...retained } = input.retained;
          const conversion = freshId();
          result = { conversion: { profile: input.profile, state: 'staged', conversion,
            observation: input.retained.intakes[0]!.observation, mappingRevision: input.mappingRevision,
            sourceDigest: input.retained.payload.byteDigest, retainedRecord: { ...retained,
              profile: 'source-retained-record-binding-v1', binding: freshId(),
              sourceRecord: input.retained.intakes.length === 1 ? input.retained.intakes[0]!.record : freshId(),
              conversion, mappingRevision: input.mappingRevision, normalizationRevision: verified.normalizationRevision },
            fieldInventory: [], createdAt: '2026-10-19T00:00:00Z' }, replayed: false };
          if (settings.corruptBinding) ((result.conversion as { retainedRecord: { recordDigest: string } }).retainedRecord).recordDigest = '0'.repeat(64);
        } else if (isSynopsis) {
          const input = body as Record<string, unknown>;
          expect(control!.mode).toBe('unestablished');
          expect(input.expectedWorkHead).toBe(control!.workHead);
          expect(input.basis).toEqual({ contentHead: null, head: null, epoch: '0', protection: null });
          const content = freshId(), head = freshId();
          control = { ...control, workHead: freshId(), contentHead: content, controlHead: head,
            controlEpoch: '1', mode: 'source-managed', value: input.value, language: input.language };
          result = { outcome: 'succeeded', work: control.work, slot: control.slot, content, control: head,
            receipt: receiptId(key!), admissionId: 'field-command', requestDigest: sha256(canonical(input)),
            authorityEpoch: '1', dataEpoch: 'epoch-1', sequence: '100', scope: `work:edit:${control.work}`, replayed: false };
        } else if (path === '/v1/semantic/changes') {
          const input = body as { target: string; expectedHead: string | null; state: unknown };
          expect(input.expectedHead).toBe(semantic.get(input.target.slice(-36))?.revision ?? null);
          const revision = freshId();
          semantic.set(input.target.slice(-36), { component: input.target, revision, state: structuredClone(input.state) });
          result = { profile: 'semantic-change-v1', component: input.target, revision,
            predecessor: input.expectedHead, receipt: receiptId(key!), replayed: false };
        } else {
          if (settings.supportRefusal) return { status: 409, body: { code: 'source_support_changed', basis: 'native-head' } };
          const input = body as RetainedSupportRequest;
          expect(input.profile).toBe('source-field-support-attachment-v2');
          expect(input.native.receipt).toMatch(/^urn:rezics:receipt:/);
          const support = freshId(), supportIdentity = freshId();
          const { profile: _profile, evidence, native, expectedHead, actingSubject: _actor, ...scope } = input;
          const value: Record<string, unknown> = { ...scope, profile: 'source-field-support-v1', state: 'recorded',
            support, supportIdentity, mappingRevision: evidence.mappingRevision, valueDigest: evidence.field.valueDigest,
            nativeRevision: expectedHead, graphReceipt: native.receipt, headGuarantee: 'verified-before-commit', outcome: 'attached',
            withdrawal: null, replayed: false, createdAt: '2026-10-19T00:00:00Z', admission: {
              profile: 'source-field-support-admission-v1', sourceRecord: input.sourceRecord, conversion: input.conversion,
              evidence, native, headGuarantee: 'verified-before-commit', correspondence: {
                normalizationRevision: SOURCE_NORMALIZATION, rule: 'dataset-record-envelope-v1',
                payloadPointers: [`/record${evidence.field.pointer}`], selectedValueDigest: evidence.field.valueDigest } },
            attachment: { profile: 'source-field-attachment-certificate-v1', receipt: receiptId(key!),
              requestDigest: sha256(canonical(input)), nativeReceipt: native.receipt } };
          if (settings.corruptSupport) (value.admission as Record<string, unknown>).headGuarantee = 'transaction-guarded';
          supports.set(shortId(support), structuredClone(value));
          result = { support: value, replayed: false };
        }
        replies.set(key!, structuredClone(result));
        if (loseReply && lost++ < 8) throw new Error('reply lost after owner commit');
        return { status: 201, body: structuredClone(result) };
      }
      const answer = await fixture.api.request(method, path, body, key);
      if (path === '/v1/sources/intakes' && answer.status < 300) {
        const observed = answer.body.observation as unknown as StagedSourceObservation;
        observations.set(observed.observation, structuredClone(observed));
      }
      if (path === '/v1/semantic/changes/bulk' && answer.status < 300) {
        const items = (body as { items: unknown[] }).items;
        (answer.body.items as { component: string; revision: string }[]).forEach((item, index) =>
          semantic.set(shortId(item.component), { component: item.component, revision: item.revision, state: structuredClone(items[index]) }));
      }
      return answer;
    } };
    const shortId = (value: string) => value.slice(-36);
    const run = async () => {
      const result = await importDataset(directory, source, options(api));
      const adoptions = JSON.parse(readFileSync(result.fieldAdoptionsFile, 'utf8')) as DatasetFieldAdoptionJournal;
      const coverage = JSON.parse(readFileSync(result.coverageFile, 'utf8'));
      expect(readFileSync(file, 'utf8')).toBe(frozen);
      return { result, adoptions, coverage };
    };
    return { run, calls, source, work, person, directory, fixture, semantic,
      editor() { control = { ...control, workHead: freshId(), contentHead: freshId(), controlHead: freshId(),
        controlEpoch: '2', mode: 'human-controlled', value: 'Later editor choice' }; },
    };
  }

  test('two exact Bangumi synopsis pointers retain independent supports for one acknowledged native command', async () => {
    const fixture = setup({ duplicateSummary: 'same' });
    const { adoptions, coverage } = await fixture.run();
    const fields = adoptions.fields.filter(field => field.field.pointer.endsWith('/summary'));
    expect(fields).toHaveLength(2);
    expect(fields.map(field => field.status)).toEqual(['mapped', 'mapped']);
    expect(fields.map(field => field.field.pointer)).toEqual(['/data/summary', '/data/api_subject/summary']);
    expect(fields[0]!.native).toEqual(fields[1]!.native);
    expect(fields[0]!.support!.key).not.toBe(fields[1]!.support!.key);
    expect(fields.map(field => (field.support!.body as RetainedSupportRequest).evidence.field.pointer))
      .toEqual(['/data/summary', '/data/api_subject/summary']);
    expect(fixture.calls.filter(call => call.method === 'POST' && call.path.endsWith('/fields/synopsis/control'))).toHaveLength(1);
    expect(fixture.calls.filter(call => call.method === 'POST' && call.path === '/v1/sources/field-supports')).toHaveLength(2);
    for (const field of fields) expect(coverage.entries.find((entry: { path: string }) => entry.path === field.field.pointer).disposition.status).toBe('mapped');
    fixture.editor();
    const replay = await fixture.run();
    expect(replay.adoptions.fields.filter(field => field.field.pointer.endsWith('/summary')).map(field => field.status)).toEqual(['pending', 'pending']);
    expect(fixture.calls.filter(call => call.method === 'POST' && call.path.endsWith('/fields/synopsis/control'))).toHaveLength(1);
    expect(fixture.calls.filter(call => call.method === 'POST' && call.path === '/v1/sources/field-supports')).toHaveLength(2);
  });

  for (const duplicateSummary of ['different-value', 'different-language'] as const) {
    test(`a ${duplicateSummary} synopsis pointer cannot reuse or overwrite the first native choice`, async () => {
      const fixture = setup({ duplicateSummary }), { adoptions } = await fixture.run();
      expect(adoptions.fields.map(field => field.status)).toEqual(['mapped', 'pending']);
      expect(adoptions.fields[1]!.reason).toContain('editor/source synopsis choice is preserved');
      expect(fixture.calls.filter(call => call.method === 'POST' && call.path.endsWith('/fields/synopsis/control'))).toHaveLength(1);
      expect(fixture.calls.filter(call => call.method === 'POST' && call.path === '/v1/sources/field-supports')).toHaveLength(1);
    });
  }

  for (const multipart of [false, true]) for (const language of [undefined, null, 'pt-BR'] as const) {
    test(`adopts exact ${multipart ? 'multipart' : 'single'} synopsis and retains ${String(language)} language through replay`, async () => {
      const fixture = setup({ multipart, ...(language !== undefined ? { language } : {}) });
      const first = await fixture.run(), binding = first.adoptions.conversions[fixture.work.key]!;
      const field = first.adoptions.fields.find(field => field.field.pointer === '/data/description')!;
      expect(field.status).toBe('mapped');
      expect(binding.request.retained.record).toEqual(fixture.work);
      expect(binding.request.retained.intakes.length > 1).toBe(multipart);
      expect(binding.conversion.retainedRecord.sourceRecord).not.toBe(binding.conversion.conversion);
      if (multipart) expect(binding.request.retained.intakes.map(part => part.record)).not.toContain(binding.conversion.retainedRecord.sourceRecord);
      expect(field.native?.body).toMatchObject({ value: fixture.work.data.description,
        language: language === undefined ? { state: 'omitted' } : language === null ? { state: 'null' } : { state: 'value', value: language } });
      expect(field.support?.body).toMatchObject({ expectedHead: field.native!.result!.content,
        native: { owner: 'work-editorial', receipt: field.native!.result!.receipt }, evidence: { field: {
          pointer: '/data/description', valueDigest: sha256(canonical(fixture.work.data.description)) } } });
      expect(field.support?.responses[0]?.status).toBe(201);
      expect(field.supportRead?.body.headGuarantee).toBe('verified-before-commit');
      expect(first.coverage.entries.find((entry: { path: string }) => entry.path === '/data/description').disposition.status).toBe('mapped');
      const writes = () => fixture.calls.filter(call => call.method === 'POST' && call.path !== '/v1/catalogue/candidates');
      const before = writes().length;
      const replay = await fixture.run();
      expect(replay.adoptions.fields.find(field => field.field.pointer === '/data/description')!.status).toBe('mapped');
      expect(writes()).toHaveLength(before);
      expect(replay.adoptions.fields.find(field => field.field.pointer === '/data/description')!.support).toEqual(field.support);
      expect(fixture.fixture.nativeWorks).toHaveLength(1);
    });
  }

  test('uses one acknowledged semantic head and preserves the complete producer state for exact facts', async () => {
    const fixture = setup({ semantic: true });
    const { adoptions } = await fixture.run();
    const field = adoptions.fields.find(field => field.field.pointer === '/data/country')!;
    expect(field.status).toBe('mapped');
    const native = field.native!.body as { state: { properties: { predicate: string }[] } };
    expect(native.state.properties.some(property => property.predicate.endsWith('semanticWork'))).toBe(true);
    expect(native.state.properties.some(property => property.predicate === 'https://schema.org/identifier')).toBe(true);
    expect(field.support!.body).toMatchObject({ native: { owner: 'semantic', component: field.native!.result!.component,
      revision: field.native!.result!.revision, receipt: field.native!.result!.receipt } });
    const state = [...fixture.semantic.values()][0]!;
    state.revision = iri(999_990);
    const properties = (state.state as { properties: unknown[] }).properties;
    properties.push({ predicate: 'https://schema.org/name', value: { kind: 'string', lexical: 'Independent editor fact' } });
    const before = fixture.calls.filter(call => call.path === '/v1/semantic/changes').length;
    const replay = await fixture.run();
    expect(replay.adoptions.fields.find(field => field.field.pointer === '/data/country')!.status).toBe('pending');
    expect(fixture.calls.filter(call => call.path === '/v1/semantic/changes')).toHaveLength(before);
    expect(properties).toContainEqual({ predicate: 'https://schema.org/name', value: { kind: 'string', lexical: 'Independent editor fact' } });
  });

  test('retains the exact native intent when its committed replies are lost and resumes the same key', async () => {
    const fixture = setup({ lostNativeReplies: true });
    const first = await fixture.run(), pending = first.adoptions.fields[0]!;
    expect(pending.status).toBe('pending');
    expect(pending.native?.result).toBeUndefined();
    expect(pending.native?.responses).toEqual([]);
    const resumed = await fixture.run(), complete = resumed.adoptions.fields[0]!;
    expect(complete.status).toBe('mapped');
    expect(complete.native?.key).toBe(pending.native?.key);
    expect(complete.native?.body).toEqual(pending.native?.body);
    expect(complete.native?.responses[0]?.status).toBe(200);
    expect(complete.native?.result?.replayed).toBe(true);
    expect(fixture.calls.filter(call => call.method === 'POST' && call.path.endsWith('/fields/synopsis/control'))).toHaveLength(9);
  });

  test('leaves an existing human synopsis alone before any native or support command', async () => {
    const fixture = setup({ human: true }), { adoptions } = await fixture.run();
    expect(adoptions.fields[0]!.reason).toContain('editor/source synopsis choice is preserved');
    expect(fixture.calls.some(call => call.method === 'POST' && call.path.endsWith('/fields/synopsis/control'))).toBe(false);
    expect(fixture.calls.some(call => call.path === '/v1/sources/field-supports')).toBe(false);
  });

  test('resumes a committed support with the original intent and records its actual replay reply', async () => {
    const fixture = setup({ lostSupportReplies: true });
    const first = await fixture.run(), pending = first.adoptions.fields[0]!;
    expect(pending.status).toBe('pending');
    expect(pending.native?.result?.outcome).toBe('succeeded');
    expect(pending.support?.result).toBeUndefined();
    const resumed = await fixture.run(), complete = resumed.adoptions.fields[0]!;
    expect(complete.status).toBe('mapped');
    expect(complete.support?.key).toBe(pending.support?.key);
    expect(complete.support?.body).toEqual(pending.support?.body);
    expect(complete.support?.responses[0]?.status).toBe(200);
    expect(complete.support?.result?.replayed).toBe(true);
    expect(fixture.calls.filter(call => call.method === 'POST' && call.path.endsWith('/fields/synopsis/control'))).toHaveLength(1);
    expect(fixture.calls.filter(call => call.method === 'POST' && call.path === '/v1/sources/field-supports')).toHaveLength(9);
  });

  test('retains support receipts but refuses current adoption when an editor moves the head during its read', async () => {
    const fixture = setup({ editorDuringSupportRead: true }), { adoptions, coverage } = await fixture.run();
    const field = adoptions.fields[0]!;
    expect(field.status).toBe('pending');
    expect(field.native?.result?.outcome).toBe('succeeded');
    expect(field.support?.result?.support).toBeDefined();
    expect(field.nativeReads).toHaveLength(2);
    expect(field.nativeReads![0]!.body.mode).toBe('source-managed');
    expect(field.nativeRead?.body.value).toBe('Concurrent editor choice');
    expect(coverage.entries.find((entry: { path: string }) => entry.path === '/data/description').disposition.status).toBe('unmapped');
  });

  test('keeps acknowledged native/support receipts after a later editor choice without replaying the mutation', async () => {
    const fixture = setup(), first = await fixture.run();
    fixture.editor();
    const replay = await fixture.run(), field = replay.adoptions.fields[0]!;
    expect(field.status).toBe('pending');
    expect(field.native?.result).toEqual(first.adoptions.fields[0]!.native!.result);
    expect(field.support?.result).toEqual(first.adoptions.fields[0]!.support!.result);
    expect(field.nativeRead?.body.value).toBe('Later editor choice');
    expect(fixture.calls.filter(call => call.method === 'POST' && call.path.endsWith('/fields/synopsis/control'))).toHaveLength(1);
  });

  for (const setting of ['supportRefusal', 'corruptBinding', 'corruptSupport', 'withdrawn'] as const) {
    test(`never promotes ${setting} into adopted field coverage`, async () => {
      const fixture = setup({ [setting]: true }), { adoptions, coverage } = await fixture.run();
      const field = adoptions.fields[0]!;
      expect(field.status).toBe('pending');
      expect(coverage.entries.find((entry: { path: string }) => entry.path === '/data/description').disposition.status).toBe('unmapped');
      if (setting === 'supportRefusal') {
        expect(field.reason).toContain('source-field-support: HTTP 409 source_support_changed native-head');
        expect(field.native?.result?.outcome).toBe('succeeded');
        expect(field.support?.responses[0]).toEqual({ status: 409, body: { code: 'source_support_changed', basis: 'native-head' } });
      }
      if (setting === 'corruptBinding') expect(field.native).toBeUndefined();
    });
  }
});
