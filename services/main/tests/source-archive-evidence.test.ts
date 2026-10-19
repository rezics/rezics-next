import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { AccessAdmissionRegistry } from '../src/modules/access/admission.ts';
import { fixtureAuthorityScenario, setFixtureMandateState } from '../src/modules/access/fixture-authority-scenario.ts';
import { grantFixtureAuthority } from '../src/modules/access/fixture-authority.ts';
import { SourceIntakeStore, SourceIntakeInvalid } from '../src/modules/source/intake.ts';
import { SourceRetainedEvidenceReader, SourceCoverEvidenceInvalid } from '../src/modules/source/cover-evidence.ts';
import { SourceArchiveEvidenceOwner, SourceArchiveConflict, SourceArchiveInvalid, SourceArchiveUnavailable,
  type RetainedArchiveInput, type VndbCopyCoordinate } from '../src/modules/source/archive-evidence.ts';
import { ASSESS_ACTION, ASSESS_SCOPE, RightsStore, type AssessmentInput } from '../src/modules/rights/store.ts';
import { VerificationStore } from '../src/modules/verification/store.ts';
import { retainedEvidenceFixture, evidenceDigest as sha } from './support/retained-evidence-fixture.ts';
import { retainedTar } from './support/source-archive-fixture.ts';

const ID = 'https://rezics.com/id/';
let fixture: Awaited<ReturnType<typeof retainedEvidenceFixture>>;
let access: AccessAdmissionRegistry, rights: RightsStore, intake: SourceIntakeStore, availability: VerificationStore;
beforeAll(async () => {
  fixture = await retainedEvidenceFixture('source_archive_owner');
  access = new AccessAdmissionRegistry(fixture.accessPool);
  rights = new RightsStore(fixture.pool, fixture.accessPool);
  intake = new SourceIntakeStore(fixture.pool);
  availability = new VerificationStore(fixture.pool);
}, 120_000);
afterAll(async () => { await fixture?.close(); });
const authority = () => fixtureAuthorityScenario(fixture.pool,
  { scope: 'work:create:root', action: 'work.create', mandate: 'work.create' });
const owner = () => new SourceArchiveEvidenceOwner(fixture.pool, intake, access, rights, fixture.objects);
const row = { id: 'c13', image: 'ch41', name: 'Test retained row' };
const coordinate: VndbCopyCoordinate = { table: 'chars', rowOrdinal: 0, rowDigest: sha(JSON.stringify(row)),
  fieldLocator: '/image', imageId: 'ch41', namespace: 'character', externalId: 'c13', role: 'portrait' };
function binary(value = retainedTar([['db/chars.header', 'id\timage\tname\n'],
  ['db/chars', 'c13\tch41\tTest retained row\nc13\tch41\tTest retained row\n']])) { return value; }

async function retained(principalId: string, bytes: Uint8Array, options: {
  provider?: string; mediaType?: string; externalId?: string; sourceRevision?: string;
} = {}) {
  return (await intake.submit(principalId, randomUUID(), { provider: options.provider ?? 'vndb',
    namespace: 'archive', externalId: options.externalId ?? 'retained-dump', sourceRevision: options.sourceRevision ?? 'frozen-1',
    mediaType: options.mediaType ?? 'application/octet-stream', retention: 'retained', rawBytesBase64: Buffer.from(bytes).toString('base64'),
    coverage: { scope: 'archive-byte-part', complete: false, omittedFields: [] }, rightsEvidence: { basis: 'unknown', note: '' } })).observation;
}
async function manifest(principalId: string, bytes = binary()): Promise<RetainedArchiveInput> {
  // Parts retain their actual independent observation receipts and ordering.
  const pieces = [bytes.subarray(0, 700), bytes.subarray(700)];
  const parts = [];
  for (const [index, piece] of pieces.entries()) {
    const observation = await retained(principalId, piece);
    parts.push({ index, record: observation.record, observation: observation.observation, byteDigest: observation.byteDigest! });
  }
  return { profile: 'source-retained-archive-v1', record: parts[0]!.record, observation: parts[0]!.observation,
    observationDigest: parts[0]!.byteDigest, archiveDigest: sha(bytes), byteLength: bytes.length,
    mediaType: 'application/x-tar', parts };
}
async function withdraw(principalId: string, observation: string) {
  return availability.recordObservationDisposition(principalId, randomUUID(), observation.slice(ID.length),
    { expectedHead: null, state: 'withdrawn', reason: 'owner test withdrawal' });
}

test('archive owner admits actual ordered binary receipts and replays the same persisted admission', async () => {
  const a = await authority(), input = await manifest(a.principalId);
  const before = fixture.puts;
  const admitted = await owner().admit(a.principal, a.actor, 'archive:stable', input);
  expect(admitted.replayed).toBe(false);
  expect(admitted.admission).toMatchObject(input);
  expect(admitted.admission.receipt).toBe(admitted.admission.admission);
  expect(await owner().admit(a.principal, a.actor, 'archive:stable', input)).toEqual({ ...admitted, replayed: true });
  expect(fixture.puts - before).toBe(1);
  await expect(owner().admit(a.principal, a.actor, 'archive:stable', { ...input, archiveDigest: 'a'.repeat(64) }))
    .rejects.toBeInstanceOf(SourceArchiveConflict);
  const first = await owner().verify(a.principal, admitted.admission.admission, coordinate);
  const second = await owner().verify(a.principal, admitted.admission.admission, { ...coordinate, rowOrdinal: 1 });
  expect(first.source).toMatchObject({ record: input.record, observation: input.observation,
    observationDigest: input.observationDigest, provider: 'vndb', namespace: 'archive', captureUrl: null });
  expect(first.row.rowDigest).toBe(coordinate.rowDigest);
  expect(second.row.rowOrdinal).toBe(1);
  expect(second.row.decodedBytes).toEqual(first.row.decodedBytes);
  expect(first.archive.parts).toEqual(input.parts);
  expect(first.archive.archiveDigest).not.toBe(first.row.rowDigest);
  expect((await intake.read(a.principalId, input.observation.slice(ID.length)))?.byteDigest).toBe(input.observationDigest);
  await expect(fixture.pool.query('UPDATE source.archive_admission SET archive_digest=$1 WHERE id=$2',
    ['a'.repeat(64), admitted.admission.admission.slice(ID.length)])).rejects.toThrow(/immutable/i);
});

test('archive owner refuses cross-principal, changed parts, invented manifests and the unchanged intake ceiling', async () => {
  const a = await authority(), other = await authority(), input = await manifest(a.principalId);
  await expect(owner().admit(other.principal, other.actor, randomUUID(), input)).rejects.toBeInstanceOf(SourceArchiveUnavailable);
  await expect(owner().admit(a.principal, a.actor, randomUUID(), { ...input, archiveDigest: 'a'.repeat(64) }))
    .rejects.toBeInstanceOf(SourceArchiveConflict);
  await expect(owner().admit(a.principal, a.actor, randomUUID(), { ...input, parts: [...input.parts].reverse() }))
    .rejects.toBeInstanceOf(SourceArchiveInvalid);
  const envelope = await retained(a.principalId, Buffer.from(JSON.stringify({ url: 'https://vndb.org/dump' })),
    { mediaType: 'application/json' });
  const asserted = { ...input, record: envelope.record, observation: envelope.observation,
    observationDigest: envelope.byteDigest!, parts: [{ index: 0, record: envelope.record,
      observation: envelope.observation, byteDigest: envelope.byteDigest! }] };
  await expect(owner().admit(a.principal, a.actor, randomUUID(), asserted)).rejects.toBeInstanceOf(SourceArchiveUnavailable);
  await expect(retained(a.principalId, Buffer.alloc(262_145))).rejects.toBeInstanceOf(SourceIntakeInvalid);
});

test('archive custody is rechecked on replay, read, withdrawal and current authority loss', async () => {
  const a = await authority(), input = await manifest(a.principalId);
  const admitted = await owner().admit(a.principal, a.actor, randomUUID(), input);
  const path = `source/archive/${a.principalId}/${input.observation.slice(ID.length)}/${input.archiveDigest}`;
  const original = fixture.bodies.get(path)!;
  fixture.bodies.set(path, Buffer.from('corrupt'));
  await expect(owner().verify(a.principal, admitted.admission.admission, coordinate)).rejects.toBeInstanceOf(SourceArchiveUnavailable);
  fixture.bodies.set(path, original);
  await withdraw(a.principalId, input.parts[1]!.observation);
  await expect(owner().verify(a.principal, admitted.admission.admission, coordinate)).rejects.toBeInstanceOf(SourceArchiveUnavailable);
  await expect(owner().admit(a.principal, a.actor, randomUUID(), input)).rejects.toBeInstanceOf(SourceArchiveUnavailable);
  const fresh = await manifest(a.principalId);
  await setFixtureMandateState(fixture.pool, a.representationId, 'revoked');
  await expect(owner().admit(a.principal, a.actor, randomUUID(), fresh)).rejects.toBeInstanceOf(SourceArchiveUnavailable);
});

test('retained projection withholds unknown quotes and never invents language or capture attribution', async () => {
  const a = await authority();
  const observation = await retained(a.principalId, Buffer.from(JSON.stringify({ name: 'Retained name', language: 'ja' })),
    { mediaType: 'application/json', provider: 'bangumi', externalId: '975' });
  const reader = new SourceRetainedEvidenceReader(fixture.pool, intake, access, rights);
  const at = { record: observation.record, observation: observation.observation, fieldLocator: '/name' };
  const projection = await reader.read(a.principal, at);
  expect(projection).toMatchObject({ representation: { sha256: observation.byteDigest,
    byteLength: observation.byteLength, mediaType: 'application/json' }, locator: { field: '/name' },
    attribution: { provider: 'bangumi', externalId: '975', captureUrl: null },
    language: null, quote: null, quoteWithheld: true, rights: { result: 'undetermined' } });
  expect((await reader.read(a.principal, { ...at, languageLocator: '/language' }))?.language).toBe('ja');
  expect(await reader.read(a.principal, { ...at, fieldLocator: '/absent' })).toBeNull();
  await expect(reader.read(a.principal, { ...at, fieldLocator: '/bad~escape' })).rejects.toBeInstanceOf(SourceCoverEvidenceInvalid);
  const other = await authority();
  expect(await reader.read(other.principal, at)).toBeNull();
  expect(JSON.stringify(projection)).not.toMatch(/principal|binding|intake|certificate|rawBytes/);
});

test('retained projection uses the current quotation assessment and refuses current withdrawal', async () => {
  const a = await authority();
  const observation = await retained(a.principalId, Buffer.from('{"name":"Retained fact"}'),
    { provider: 'bangumi', mediaType: 'application/json', externalId: '977' });
  await grantFixtureAuthority(fixture.pool, { scope: ASSESS_SCOPE, requireDispatch: true,
    representations: [{ principalId: a.principalId, actor: a.actor, action: ASSESS_ACTION, lifetime: 'infinity' }],
    grant: { actor: a.actor, action: ASSESS_ACTION, lifetime: 'infinity' } });
  const input: AssessmentInput = { actingSubject: a.actor, material: { scopeKind: 'source_record', provider: null,
    namespace: null, sourceRecordId: observation.record.slice(ID.length), contentVariantId: null,
    mediaAsset: null, component: 'record' }, family: 'data_rights', useKind: 'quotation', useScope: 'rezics:export:quotation',
    expressionKind: 'fact', basis: 'unprotected_fact', outcome: 'supported', licenseInstrument: null,
    exceptionKind: null, rationale: 'Isolated owner-test factual name', extent: {}, evidence: {}, obligations: [],
    expectedAssessment: null, idempotencyKey: randomUUID() };
  const assessed = await rights.assess(a.principal, input);
  const reader = new SourceRetainedEvidenceReader(fixture.pool, intake, access, rights);
  const at = { record: observation.record, observation: observation.observation, fieldLocator: '/name' };
  expect(await reader.read(a.principal, at)).toMatchObject({ quote: 'Retained fact', quoteWithheld: false,
    rights: { result: 'supported' } });
  await rights.assess(a.principal, { ...input, outcome: 'undetermined', basis: 'unknown',
    expectedAssessment: assessed.assessmentId, idempotencyKey: randomUUID() });
  expect(await reader.read(a.principal, at)).toMatchObject({ quote: null, quoteWithheld: true });
  await withdraw(a.principalId, observation.observation);
  expect(await reader.read(a.principal, at)).toBeNull();
});
