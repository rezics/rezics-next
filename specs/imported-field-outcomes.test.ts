import { afterEach, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fromPlainText, serializeDocument } from '../packages/document/src';
import type { Field, ImportedFieldDriver, Reply, Tuple } from './imported-field-driver';

setDefaultTimeout(120_000);
let driver: ImportedFieldDriver;
beforeEach(async () => {
  const location = process.env.IMPORTED_FIELD_DRIVER;
  if (!location) throw new Error('Imported field outcome driver is required');
  if (!isAbsolute(location) && !location.startsWith('file:')) throw new Error('IMPORTED_FIELD_DRIVER must be absolute or a file URL');
  const url = isAbsolute(location) ? pathToFileURL(location) : new URL(location);
  if (url.protocol !== 'file:') throw new Error('IMPORTED_FIELD_DRIVER must use a file URL');
  const binding = await import(url.href);
  if (typeof binding.createImportedFieldDriver !== 'function') throw new Error('Expected createImportedFieldDriver factory');
  driver = await binding.createImportedFieldDriver();
  await driver.setTime('2030-01-02T00:00:00.000Z');
});
afterEach(async () => { const current = driver; driver = undefined!; await current?.close(); });
const key = () => randomUUID();
const tuple: Tuple = { source: 'bangumi', externalId: '42', fieldGroup: 'summary' };
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function field(): Field {
  const document = fromPlainText('Full source summary: first paragraph.\nSecond paragraph, including the ending.');
  return { ...tuple, subjectId: driver.subject.id, document, recordRevision: 'unversioned',
    digest: sha(new TextEncoder().encode(serializeDocument(document))), converterRevision: 'summary-v1',
    references: ['https://bgm.tv/subject/42'],
    rights: { spdx: 'CC-BY-SA-3.0', obligations: ['cc:Attribution', 'cc:ShareAlike'], attribution: 'via Bangumi' } };
}
function success(reply: Reply) { expect(reply.status).toBeGreaterThanOrEqual(200); expect(reply.status).toBeLessThan(300); }
async function noEffect(run: () => Promise<Reply>, status: number) {
  const before = await driver.effects(); const reply = await run(); expect(reply.status).toBe(status);
  expect(await driver.effects()).toEqual(before); return reply;
}
async function imported() {
  const input = await driver.fetchFixture('valid'); const id = key();
  success(await driver.importUrl('importer', input, id)); await driver.drain();
  const media = await driver.media(id); expect(media.state).toBe('available'); return { input, id, media };
}

test('source documents fence race and imported cover API outcomes remain red without implementation', async () => {
  const input = field(); const id = key(); success(await driver.refresh('importer', input, id));
  const c = await driver.contribution(id);
  expect(c.bytes).toEqual(new TextEncoder().encode(serializeDocument(input.document)));
  expect(c.digest).toBe(sha(c.bytes));
  expect(await driver.hashEvidence(c.documentId)).toEqual({ nativeDigest: c.digest, mismatchedWriteRejected: true });
  const { document: _document, subjectId: _subjectId, ...provenance } = input;
  expect(c.provenance).toEqual(provenance);
  expect(c.semantic).toEqual({ documentId: c.documentId, digest: c.digest, body: null,
    transactionId: c.transactionId, adoption: 'proposal' });
  expect(c.partition).toBe(driver.subject.partition);
  const trace = await driver.trace(id); expect(trace.crossPartitionJoins).toBe(0);
  expect(trace.writes.length).toBeGreaterThan(0);
  expect(trace.writes.every(w => w.partition === c.partition && w.transactionId === c.transactionId)).toBe(true);
  success(await driver.exact('importer', c.documentId, c.revision));
  const manual = await driver.adoptManual();
  // An unchanged statement from the same tuple resolves to its existing contribution; a source revision is recorded
  // with the document it changed.
  const revised = fromPlainText('Full source summary: revised at the source.');
  for (const [recordRevision, document] of [['native-revision-2', revised], ['unversioned', input.document]] as const) {
    const refreshKey = key();
    const digest = sha(new TextEncoder().encode(serializeDocument(document)));
    success(await driver.refresh('importer', { ...input, recordRevision, document, digest }, refreshKey));
    expect((await driver.contribution(refreshKey)).provenance.recordRevision).toBe(recordRevision);
    expect(await driver.adopted()).toBe(manual);
  }
  for (const untrusted of [{ published: true }, { rights: { spdx: 'CC0-1.0' } }]) {
    await noEffect(() => driver.refresh('account', input, key(), untrusted), 403);
    const spoofKey = key(); const spoof = await driver.refresh('importer', input, spoofKey, untrusted);
    // Reject conflicting assertions or ignore them; never publish/adopt or alter the trusted rights.
    if (spoof.status >= 200 && spoof.status < 300) {
      const stored = await driver.contribution(spoofKey);
      expect(stored.provenance.rights).toEqual(input.rights); expect(stored.semantic.adoption).toBe('proposal');
      expect(await driver.adopted()).toBe(manual);
    } else expect([400, 403]).toContain(spoof.status);
  }
});

test('tuple fence read and governance use protected grants scopes trusted time and one stable home', async () => {
  const home = await driver.tupleHome(tuple);
  expect(await driver.tupleHome({ ...tuple, fieldGroup: 'cover' })).toEqual(home);
  await driver.mergeSubject(); expect(await driver.tupleHome(tuple)).toEqual(home);
  for (const as of ['anonymous', 'account'] as const) {
    expect((await driver.check(as, tuple)).status).toBe(as === 'anonymous' ? 401 : 403);
    await noEffect(() => driver.fence(as, tuple, key()), as === 'anonymous' ? 401 : 403);
  }
  for (const as of ['importer', 'governance'] as const)
    expect(await driver.check(as, tuple)).toEqual({ status: 200, body: { fenced: false, securityRevision: null } });
  expect((await driver.check('importer', { ...tuple, externalId: '' })).status).toBe(400);
  const revisions: bigint[] = [];
  for (let n = 0; n < 2; n++) {
    const id = key(); success(await driver.fence('governance', tuple, id));
    const read = await driver.check('importer', tuple);
    expect(read.status).toBe(200);
    const body = read.body as { fenced: boolean; securityRevision: string };
    expect(body.fenced).toBe(true); expect(body.securityRevision).toMatch(/^\d+$/);
    expect(Object.keys(body).sort()).toEqual(['fenced', 'securityRevision']); revisions.push(BigInt(body.securityRevision));
    const trace = await driver.trace(id);
    expect([...new Set(trace.writes.map(write => write.partition))]).toEqual([home.partition]);
    expect(trace.crossPartitionJoins).toBe(0);
    expect(trace.authorization).toContainEqual({ action: 'source_fence:takedown', anchor: driver.platformResource,
      at: '2030-01-02T00:00:00.000Z', allowed: true });
  }
  expect(revisions[1]!).toBeGreaterThan(revisions[0]!);
  await driver.access('importer', 'source_fence:read', 'revoke-grant');
  expect((await driver.check('importer', tuple)).status).toBe(403);
  await driver.access('governance', 'source_fence:read', 'remove-scope');
  expect((await driver.check('governance', tuple)).status).toBe(403);
  await driver.access('governance', 'source_fence:takedown', 'revoke-grant');
  await noEffect(() => driver.fence('governance', tuple, key()), 403);
});

test('unchanged receipt and changed refresh recheck fence before body with no new effect', async () => {
  const input = field(); const id = key(); success(await driver.refresh('importer', input, id));
  success(await driver.fence('governance', tuple, key()));
  for (const refreshKey of [id, key()]) {
    await noEffect(() => driver.refresh('importer', input, refreshKey), 409);
    expect((await driver.trace(refreshKey)).fenceChecks).toContainEqual({ tuple,
      authoritativeTime: '2030-01-02T00:00:00.000Z', beforeReceiptAndBody: true });
  }
  await noEffect(() => driver.refresh('importer', { ...input, recordRevision: 'new' }, key()), 409);
});

test('fence after preparation hides final disclosure and exact bytes through projection replay and merge', async () => {
  await driver.projection('pause'); const id = key(); const input = field();
  const race = await driver.race(input, id);
  expect(race.prepared).toBe(true); expect(race.fenceCommittedBeforeWrite).toBe(true); success(race.write);
  const c = await driver.contribution(id);
  expect((await driver.trace(id)).crossPartitionJoins).toBe(0);
  for (const step of ['paused', 'drain', 'replay', 'merge'] as const) {
    if (step === 'merge') await driver.mergeSubject();
    else if (step !== 'paused') await driver.projection(step);
    for (const as of ['anonymous', 'account', 'importer'] as const) {
      const disclosed = await driver.disclose(as);
      expect(disclosed.documents).not.toContain(c.documentId); expect(disclosed.bodies).not.toContain(serializeDocument(input.document));
      const exact = await driver.exact(as, c.documentId, c.revision);
      expect(exact.status).toBe(404); expect(JSON.stringify(exact.body)).not.toContain('Full source summary');
    }
    await noEffect(() => driver.refresh('importer', input, id), 409);
  }
});

test('ordinary bulk bearer imports real reencoded cover bytes and claims within semantic transaction', async () => {
  const { id, input, media } = await imported(); const evidence = await driver.imageEvidence(id);
  expect(media.uploaderId).toBe(driver.importerId); expect(media.transitions).toEqual(['reserved', 'uploaded', 'available']);
  expect(evidence).toMatchObject({ sub: driver.importerId, principalKind: 'account', websiteSession: false,
    tokenExchange: false, clientActor: false, sharedPipeline: true, limitInputPixels: 40_000_000 });
  expect(evidence.scopes).not.toContain('media:complete'); expect(evidence.sharpVersion).not.toBe('');
  expect(['avif', 'webp']).toContain(evidence.decoded.format); expect(evidence.decoded.metadata).toEqual([]);
  expect(evidence.decoded.width * evidence.decoded.height).toBeLessThanOrEqual(40_000_000);
  expect(media.bytes.length).toBeGreaterThan(0);
  for (const cap of Object.values(evidence.configuredCaps)) expect(cap).toBeGreaterThan(0);
  expect(media.role).toBe('cover'); expect(media.imageLicence).toBeNull(); expect(media.credit).toContain('(c) rights holder'); expect(media.credit).toContain('via');
  expect(media.sourceLink).toBe(input.provenance.references[0]!);
  const command = key(); success(await driver.cover('importer', media.id, command));
  const ref = await driver.coverReference(command);
  expect(ref).toMatchObject({ mediaId: media.id, role: 'cover', credit: media.credit, sourceLink: media.sourceLink,
    partition: driver.subject.partition });
  expect(ref.claimTransactionId).toBe(ref.commandTransactionId);
  expect((await driver.media(id)).claimedAt).not.toBeNull();
  expect((await driver.completeAsImporter(media.id)).status).toBe(403);
});

test('URL policy caps and invalid image rejection purge samples durably without fabricated media states', async () => {
  for (const kind of ['unallowed-host', 'unsafe-redirect', 'redirect-limit', 'byte-limit', 'timeout', 'over-pixel', 'malformed'] as const) {
    const id = key(); const input = await driver.fetchFixture(kind);
    await driver.failNextPurge(); const response = await driver.importUrl('importer', input, id);
    expect([202, 400, 403, 408, 413, 422, 504]).toContain(response.status); await driver.drain();
    const rejected = await driver.rejectedImport(id);
    expect(rejected.storedKeys).toEqual([]); expect(rejected.pendingPurge).toBe(false);
    expect(await driver.fetchEvidence(id)).toEqual({ unallowedRequests: [], unsafeRequests: [] });
    if (kind === 'over-pixel' || kind === 'malformed') {
      expect(rejected.media).not.toBeNull(); expect(rejected.media!.transitions).toEqual(['reserved', 'uploaded', 'rejected']);
    }
    if (rejected.media) {
      expect(rejected.media.state).toBe('rejected'); expect(rejected.media.storedKeys).toEqual([]);
      expect(rejected.media.bytes.length).toBe(0); expect(rejected.media.claimedAt).toBeNull();
      expect((await driver.download('anonymous', rejected.media.id)).status).toBe(404);
    }
  }
});

test('denied invalid and aborted semantic cover commands leak no claim', async () => {
  for (const mode of ['denied', 'invalid-proposal', 'before-commit', 'non-cover-role'] as const) {
    const { media, id } = await imported();
    const before = await driver.effects();
    const reply = await driver.cover(mode === 'denied' ? 'account' : 'importer', media.id, key(),
      mode === 'denied' ? undefined : mode);
    expect(reply.status).toBe(mode === 'invalid-proposal' || mode === 'non-cover-role' ? 400 : 403);
    expect(await driver.effects()).toEqual(before); expect((await driver.media(id)).claimedAt).toBeNull();
  }
});

test('current container and tuple rights fence guard every cover download and refresh cannot restore it', async () => {
  const { media, input, id } = await imported(); const command = key(); success(await driver.cover('importer', media.id, command));
  success(await driver.download('anonymous', media.id)); const before = (await driver.imageEvidence(id)).fetches;
  for (const mode of ['private', 'taken-down'] as const) {
    await driver.setContainer(mode);
    for (const conditional of [undefined, sha(media.bytes)]) expect((await driver.download('account', media.id, conditional)).status).toBe(404);
  }
  await driver.setContainer('public'); success(await driver.download('anonymous', media.id));
  await driver.projection('pause'); await driver.rightsTakedown(media.id, input.provenance);
  for (const mode of ['pause', 'drain', 'replay'] as const) {
    await driver.projection(mode); expect((await driver.disclose('anonymous')).media).not.toContain(media.id);
    expect((await driver.download('anonymous', media.id, sha(media.bytes))).status).toBe(404);
    await noEffect(() => driver.importUrl('importer', input, id), 409);
    await noEffect(() => driver.cover('importer', media.id, command), 409);
  }
  expect((await driver.imageEvidence(id)).fetches).toEqual(before);
});

test('actual checkGrowth observes bounded source tuple and document accesses', async () => {
  const documentBytes = new TextEncoder().encode(serializeDocument(field().document)).length;
  const result = await driver.checkGrowth({ scales: [32, 256, 2048], changedRows: [1, 4], documentBytes });
  expect(result.harness).toBe('checkGrowth'); expect(result.seedCalls).toEqual([32, 256, 2048]); expect(result.passed).toBe(true);
  expect(result.samples).toHaveLength(30);
  for (const changedRows of [1, 4]) for (const operation of ['hook', 'fence', 'reference', 'import', 'job']) {
    const samples = result.samples.filter(s => s.changedRows === changedRows && s.operation === operation);
    expect(samples.map(s => s.scale)).toEqual([32, 256, 2048]);
    for (const sample of samples) {
      expect(sample.samePartition).toBe(true); expect(sample.documentBytes).toBe(documentBytes);
      expect(sample.imageBytes).toBeGreaterThan(0); expect(sample.imageBytes).toBe(samples[0]!.imageBytes);
      for (const count of [sample.rows, sample.statements, sample.buffers]) { expect(Number.isFinite(count)).toBe(true); expect(count).toBeGreaterThan(0); }
      expect(sample.rows).toBe(samples[0]!.rows); expect(sample.statements).toBe(samples[0]!.statements);
      // Native buffer growth is checked by shared checkGrowth's logarithmic bound.
    }
  }
});
