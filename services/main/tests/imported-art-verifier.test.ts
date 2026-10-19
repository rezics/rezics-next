import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { ContentCore } from '../../content/src/index.ts';
import { AccessAdmissionRegistry } from '../src/modules/access/admission.ts';
import { fixtureAuthorityScenario } from '../src/modules/access/fixture-authority-scenario.ts';
import { DEFAULT_MEDIA_CONTEXT, MediaStore } from '../src/modules/media/store.ts';
import { avatarDigest, uploadDigest } from '../src/modules/media/commands.ts';
import { ImportedArtNativeVerifier, type ImportedArtNativeBasis } from '../src/modules/media/imported-art.ts';
import type { ImportedCoverProvenance } from '../src/modules/media/typed-schema.ts';
import { SourceIntakeStore } from '../src/modules/source/intake.ts';
import { SourceCoverEvidenceVerifier } from '../src/modules/source/cover-evidence.ts';
import { VerificationStore } from '../src/modules/verification/store.ts';
import { retainedEvidenceFixture, evidenceDigest as sha } from './support/retained-evidence-fixture.ts';

const ID = 'https://rezics.com/id/';
let fixture: Awaited<ReturnType<typeof retainedEvidenceFixture>>;
let media: MediaStore, access: AccessAdmissionRegistry, intake: SourceIntakeStore, source: SourceCoverEvidenceVerifier;
beforeAll(async () => {
  fixture = await retainedEvidenceFixture('imported_art_verifier');
  media = new MediaStore(fixture.pool, new ContentCore(fixture.pool));
  access = new AccessAdmissionRegistry(fixture.accessPool);
  intake = new SourceIntakeStore(fixture.pool);
  source = new SourceCoverEvidenceVerifier(intake, fixture.pool);
}, 120_000);
afterAll(async () => { await fixture?.close(); });
const verifier = () => new ImportedArtNativeVerifier(media, access, source, fixture.objects);

/** Real owner ledgers with a synthetic byte store. This tests acknowledgment,
 * not real artwork eligibility, image decoding or public delivery. */
async function acknowledgedCover(options: { seal?: boolean; imported?: boolean; provider?: string } = {}) {
  const target = `${ID}${randomUUID()}`;
  const authority = await fixtureAuthorityScenario(fixture.pool,
    { scope: `media:avatar:${target}`, action: 'media.avatar', mandate: 'media.avatar' });
  const bytes = Buffer.from(`owner-test-image:${randomUUID()}`), digest = sha(bytes);
  const sourceFields = { provider: options.provider ?? 'bangumi', namespace: 'subject', externalId: '975', sourceRevision: 'frozen-1',
    component: null, datasetSnapshotDigest: sha('frozen-snapshot'), recordDigest: sha('record'),
    fieldLocator: '/images/large', displayName: 'Bangumi', href: 'https://bgm.tv/subject/975' };
  const image = { captureUrl: 'https://lain.bgm.tv/pic/cover/l/75/78/975_05MrM.jpg', captureDigest: digest,
    byteLength: bytes.length, mediaType: 'image/png' as const };
  const envelope = Buffer.from(JSON.stringify({ profile: 'source-cover-evidence-v1',
    source: sourceFields, image, holderEvidence: null }));
  const observation = (await intake.submit(authority.principalId, randomUUID(), {
    provider: sourceFields.provider, namespace: sourceFields.namespace, externalId: sourceFields.externalId,
    sourceRevision: sourceFields.sourceRevision, mediaType: 'application/json', retention: 'retained',
    rawBytesBase64: envelope.toString('base64'), coverage: { scope: 'cover-evidence', complete: false, omittedFields: [] },
    rightsEvidence: { basis: 'unknown', note: '' },
  })).observation;
  const provenance: ImportedCoverProvenance = { format: 'media-imported-cover-v1', targetWork: target,
    source: { ...sourceFields, record: observation.record, observation: observation.observation,
      observationDigest: observation.byteDigest! }, image, originalDigest: digest, holderEvidence: null };
  const input = { asset: null, mediaType: 'image/png' as const, byteLength: bytes.length,
    sha256: digest, disclosure: 'public' as const, ...(options.imported === false ? {} : { importedCover: provenance }) };
  const upload = await media.reserveUpload({ admissionId: randomUUID(), principalId: authority.principalId,
    actingSubject: authority.actor, authorityEpoch: '1', requestDigest: uploadDigest(input) }, input);
  await fixture.objects(upload.objectNamespace).put(bytes);
  await media.settleUpload(upload.upload, { status: 'activated', sha256: digest,
    byteLength: bytes.length, mediaType: 'image/png', width: 16, height: 24 }, async () => digest);
  const assetRevision = await media.recordAssetRevision(upload.upload);
  const selection = { target, context: DEFAULT_MEDIA_CONTEXT, expectedSelection: null, asset: upload.asset, crop: null };
  const request = { principal: authority.principal, actingSubject: authority.actor, scope: `media:avatar:${target}`,
    action: 'media.avatar', idempotencyKey: randomUUID(), requestDigest: avatarDigest(selection) };
  const registered = await access.register(request);
  await access.claim(registered.id, registered.requestDigest, authority.principal);
  const selected = await media.selectAvatar({ admissionId: registered.id, principalId: authority.principalId,
    actingSubject: authority.actor, authorityEpoch: registered.authorityEpoch, requestDigest: registered.requestDigest }, selection);
  const use = (await fixture.pool.query<{ use_id: string }>(
    'SELECT use_id FROM media.selection_revision WHERE id=$1', [selected.id])).rows[0]!.use_id;
  // The command owner produces and seals its terminal proof. The verifier
  // subsequently reads this stored receipt; it never constructs this name.
  const receipt = `urn:rezics:receipt:${sha(`${registered.id}\0media-avatar`)}`;
  const seal = () => access.recordGraphOutcome(registered.id, { outcome: 'succeeded', receipt,
    admissionId: registered.id, requestDigest: registered.requestDigest, authorityEpoch: registered.authorityEpoch,
    scope: request.scope, dataEpoch: selected.position.dataEpoch, sequence: selected.position.sequence });
  if (options.seal !== false) await seal();
  const native: ImportedArtNativeBasis = { kind: 'media-use', target, component: `${ID}${use}`,
    revision: `${ID}${selected.id}`, receipt, variant: `urn:rezics:variant:${upload.asset}`, role: 'cover', context: DEFAULT_MEDIA_CONTEXT };
  return { ...authority, bytes, provenance, observation, upload, assetRevision, native, registered, seal,
    selected: { value: image.captureUrl, language: null } };
}

test('native verifier resolves the actual acknowledged command, Use, variant, bytes and current head', async () => {
  const cover = await acknowledgedCover();
  expect(await access.readAcknowledgedOwnerCommand(cover.principal, cover.native.receipt)).toMatchObject({
    admissionId: cover.registered.id, receipt: cover.native.receipt, action: 'media.avatar',
    requestDigest: cover.registered.requestDigest, scope: `media:avatar:${cover.native.target}` });
  expect(await verifier().verify(cover.principal, cover.native, cover.selected)).toEqual({ status: 'verified',
    native: cover.native, receipt: cover.native.receipt, revision: cover.native.revision,
    headGuarantee: 'verified-before-commit', originalDigest: sha(cover.bytes), representationDigest: sha(cover.bytes) });
  expect(await verifier().verify(cover.principal, cover.native, cover.selected)).toMatchObject({ status: 'verified' });
  expect((await fixture.pool.query('SELECT count(*)::int AS count FROM media.use WHERE id=$1',
    [cover.native.component.slice(ID.length)])).rows[0]!.count).toBe(1);
});

test('a Use, revision or unsealed receipt cannot manufacture acknowledgment', async () => {
  const cover = await acknowledgedCover({ seal: false });
  const missing = { status: 'unavailable', reason: 'evidence-unavailable' } as const;
  expect(await verifier().verify(cover.principal, cover.native, cover.selected)).toEqual(missing);
  expect(await verifier().verify(cover.principal, { ...cover.native, receipt: cover.native.component }, cover.selected)).toEqual(missing);
  expect(await verifier().verify(cover.principal, { ...cover.native, receipt: cover.native.revision }, cover.selected)).toEqual(missing);
  await cover.seal();
  expect(await verifier().verify(cover.principal, cover.native, cover.selected)).toMatchObject({ status: 'verified' });
  const other = await fixtureAuthorityScenario(fixture.pool,
    { scope: 'work:create:root', action: 'work.create', mandate: 'work.create' });
  expect(await access.readAcknowledgedOwnerCommand(other.principal, cover.native.receipt)).toBeNull();
  expect(await verifier().verify(other.principal, cover.native, cover.selected)).toEqual(missing);
});

test('native target, retained value and current head mismatches remain distinct', async () => {
  const cover = await acknowledgedCover();
  for (const change of [{ target: `${ID}${randomUUID()}` }, { context: `${ID}${randomUUID()}` },
    { variant: `${ID}${randomUUID()}` }]) {
    expect(await verifier().verify(cover.principal, { ...cover.native, ...change }, cover.selected))
      .toEqual({ status: 'mismatch', basis: 'native-target' });
  }
  for (const selected of [{ value: 'https://example.test/substitute.png', language: null },
    { value: cover.selected.value, language: 'ja' }]) {
    expect(await verifier().verify(cover.principal, cover.native, selected)).toEqual({ status: 'mismatch', basis: 'native-value' });
  }
  expect(await verifier().verify(cover.principal, { ...cover.native, revision: `${ID}${randomUUID()}` }, cover.selected))
    .toEqual({ status: 'mismatch', basis: 'native-head' });
  const input = { target: cover.native.target, context: DEFAULT_MEDIA_CONTEXT,
    expectedSelection: cover.native.revision.slice(ID.length), asset: null, crop: null };
  await media.selectAvatar({ admissionId: randomUUID(), principalId: cover.principalId, actingSubject: cover.actor,
    authorityEpoch: '1', requestDigest: avatarDigest(input) }, input);
  expect(await verifier().verify(cover.principal, cover.native, cover.selected)).toEqual({ status: 'mismatch', basis: 'native-head' });
});

test('native verifier refuses ordinary uploads and unsupported archive, portrait and screenshot custody', async () => {
  const ordinary = await acknowledgedCover({ imported: false });
  expect(await verifier().verify(ordinary.principal, ordinary.native, ordinary.selected))
    .toEqual({ status: 'unavailable', reason: 'evidence-unavailable' });
  const cover = await acknowledgedCover();
  for (const role of ['portrait', 'screenshot'] as const) {
    expect(await verifier().verify(cover.principal, { ...cover.native, role }, cover.selected))
      .toEqual({ status: 'unavailable', reason: 'unsupported-profile' });
  }
  const jsonVndb = await acknowledgedCover({ provider: 'vndb' });
  expect(await verifier().verify(jsonVndb.principal, jsonVndb.native, jsonVndb.selected))
    .toEqual({ status: 'unavailable', reason: 'unsupported-profile' });
});

test('native verifier rechecks real custody, current source withdrawal and active principal', async () => {
  const cover = await acknowledgedCover();
  const path = `${cover.upload.objectNamespace}${sha(cover.bytes)}`;
  fixture.bodies.set(path, Buffer.from('substituted'));
  expect(await verifier().verify(cover.principal, cover.native, cover.selected)).toEqual({ status: 'unavailable', reason: 'evidence-unavailable' });
  fixture.bodies.set(path, cover.bytes);
  await new VerificationStore(fixture.pool).recordObservationDisposition(cover.principalId, randomUUID(),
    cover.observation.observation.slice(ID.length), { expectedHead: null, state: 'withdrawn', reason: 'test withdrawal' });
  expect(await verifier().verify(cover.principal, cover.native, cover.selected)).toEqual({ status: 'unavailable', reason: 'evidence-unavailable' });
  const active = await acknowledgedCover();
  await fixture.pool.query('UPDATE access.principal SET active=false WHERE id=$1', [active.principalId]);
  expect(await verifier().verify(active.principal, active.native, active.selected)).toEqual({ status: 'unavailable', reason: 'owner-unavailable' });
});
