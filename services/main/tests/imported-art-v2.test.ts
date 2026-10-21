import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { ContentCore } from '../../content/src/index.ts';
import { AccessAdmissionRegistry, type RegisteredAdmission } from '../src/modules/access/admission.ts';
import { fixtureAuthorityScenario } from '../src/modules/access/fixture-authority-scenario.ts';
import { grantFixtureAuthority } from '../src/modules/access/fixture-authority.ts';
import { DEFAULT_MEDIA_CONTEXT, MediaFenced, MediaInvalid, MediaStore, assetVariant } from '../src/modules/media/store.ts';
import { sealMediaAdmission, uploadDigest } from '../src/modules/media/commands.ts';
import { ImportedArtNativeVerifier, importedArtDeliveryEligible, importedArtMaterial } from '../src/modules/media/imported-art.ts';
import type { ImportedArtNativeBasis } from '../src/modules/media/imported-art.ts';
import type { ImportedCoverProvenance } from '../src/modules/media/typed-schema.ts';
import { SourceIntakeStore } from '../src/modules/source/intake.ts';
import { SourceCoverEvidenceVerifier, SourceCoverEvidenceInvalid, SourceCoverEvidenceUnavailable,
  SourceMediaEvidenceVerifier } from '../src/modules/source/cover-evidence.ts';
import { SourceArchiveEvidenceOwner, type VndbCopyCoordinate } from '../src/modules/source/archive-evidence.ts';
import { ASSESS_ACTION, ASSESS_SCOPE, RightsStore, type AssessmentInput } from '../src/modules/rights/store.ts';
import { VerificationStore } from '../src/modules/verification/store.ts';
import { retainedEvidenceFixture, evidenceDigest as sha } from './support/retained-evidence-fixture.ts';
import { retainedTar } from './support/source-archive-fixture.ts';

const ID = 'https://rezics.com/id/';
let f: Awaited<ReturnType<typeof retainedEvidenceFixture>>, access: AccessAdmissionRegistry,
  intake: SourceIntakeStore, rights: RightsStore, media: MediaStore, source: SourceMediaEvidenceVerifier;
beforeAll(async () => {
  f = await retainedEvidenceFixture('imported_art_v2');
  access = new AccessAdmissionRegistry(f.accessPool); intake = new SourceIntakeStore(f.pool);
  rights = new RightsStore(f.pool, f.accessPool); media = new MediaStore(f.pool, new ContentCore(f.pool));
  source = new SourceMediaEvidenceVerifier(intake, f.pool, access,
    new SourceArchiveEvidenceOwner(f.pool, intake, access, rights, f.objects));
}, 120_000);
afterAll(async () => { await f?.close(); });

/** Real isolated owner receipts and COPY bytes; deliberately synthetic artwork,
 * not a genuine corpus capture or a browser/public delivery acceptance receipt. */
async function artwork(role: 'portrait' | 'screenshot', provider: 'vndb' | 'bangumi' = 'vndb') {
  const target = `${ID}${randomUUID()}`;
  const a = await fixtureAuthorityScenario(f.pool,
    { scope: `media:avatar:${target}`, action: 'media.avatar', mandate: 'media.avatar' });
  const bytes = Buffer.from(`synthetic-owner-artwork:${randomUUID()}`), originalDigest = sha(bytes);
  let archive: Extract<ImportedCoverProvenance, { format: 'media-imported-art-v2' }>['archive'] = null;
  let recordDigest: string, fieldLocator: string, captureUrl: string;
  let observation;
  if (provider === 'vndb') {
    await grantFixtureAuthority(f.pool, { scope: 'work:create:root', requireDispatch: true,
      representations: [{ principalId: a.principalId, actor: a.actor, action: 'work.create', lifetime: 'infinity' }],
      grant: { actor: a.actor, action: 'work.create', lifetime: 'infinity' } });
    const portrait = role === 'portrait', table = portrait ? 'chars' : 'vn_screenshots';
    const raw = portrait ? { id: 'c13', image: 'ch41', name: 'Test retained row' } : { id: 'v17', scr: 'sf43' };
    const archiveBytes = retainedTar([[`db/${table}.header`, Object.keys(raw).join('\t') + '\n'],
      [`db/${table}`, Object.values(raw).join('\t') + '\n']]);
    observation = (await intake.submit(a.principalId, randomUUID(), { provider, namespace: 'archive',
      externalId: randomUUID(), sourceRevision: 'frozen-1', mediaType: 'application/octet-stream', retention: 'retained',
      rawBytesBase64: archiveBytes.toString('base64'), coverage: { scope: 'archive-byte-part', complete: false, omittedFields: [] },
      rightsEvidence: { basis: 'unknown', note: '' } })).observation;
    recordDigest = sha(JSON.stringify(raw)); fieldLocator = portrait ? '/image' : '/scr';
    const coordinate: VndbCopyCoordinate = { table, rowOrdinal: 0, rowDigest: recordDigest, fieldLocator,
      imageId: portrait ? 'ch41' : 'sf43', namespace: portrait ? 'character' : 'vn', externalId: portrait ? 'c13' : 'v17', role };
    const admitted = await new SourceArchiveEvidenceOwner(f.pool, intake, access, rights, f.objects).admit(a.principal, a.actor,
      randomUUID(), { profile: 'source-retained-archive-v1', record: observation.record, observation: observation.observation,
        observationDigest: observation.byteDigest!, archiveDigest: sha(archiveBytes), byteLength: archiveBytes.length,
        mediaType: 'application/x-tar', parts: [{ index: 0, record: observation.record, observation: observation.observation,
          byteDigest: observation.byteDigest! }] });
    archive = { admission: admitted.admission.admission, coordinate };
    captureUrl = `https://t.vndb.org/${portrait ? 'ch/41/41' : 'sf/43/43'}.jpg`;
  } else {
    captureUrl = 'https://lain.bgm.tv/pic/crt/l/13.jpg'; fieldLocator = '/images/large';
    const raw = Buffer.from(JSON.stringify({ id: 13, images: { large: captureUrl }, copyright: 'Test artwork holder' }));
    observation = (await intake.submit(a.principalId, randomUUID(), { provider, namespace: 'character', externalId: '13',
      sourceRevision: 'frozen-1', mediaType: 'application/json', retention: 'retained', rawBytesBase64: raw.toString('base64'),
      coverage: { scope: 'provider-response', complete: false, omittedFields: [] }, rightsEvidence: { basis: 'unknown', note: '' } })).observation;
    recordDigest = sha(raw);
  }
  const provenance: ImportedCoverProvenance = { format: 'media-imported-art-v2', targetWork: target, role, archive,
    source: { record: observation.record, observation: observation.observation, component: null,
      provider, namespace: observation.namespace, externalId: observation.externalId, sourceRevision: observation.sourceRevision,
      observationDigest: observation.byteDigest!, datasetSnapshotDigest: sha('frozen-test-snapshot'), recordDigest,
      fieldLocator, displayName: provider === 'vndb' ? 'VNDB' : 'Bangumi', href: `https://${provider === 'vndb' ? 'vndb.org/c13' : 'bgm.tv/character/13'}` },
    image: { captureUrl, captureDigest: originalDigest, byteLength: bytes.length, mediaType: 'image/png' },
    originalDigest, holderEvidence: null };
  await source.verifyCurrent(a.principal, provenance);
  const input = { asset: null, mediaType: 'image/png' as const, byteLength: bytes.length, sha256: originalDigest,
    disclosure: 'public' as const, importedCover: provenance };
  const upload = await media.reserveUpload({ admissionId: randomUUID(), principalId: a.principalId,
    actingSubject: a.actor, authorityEpoch: '1', requestDigest: uploadDigest(input) }, input);
  await f.objects(upload.objectNamespace).put(bytes);
  await media.settleUpload(upload.upload, { status: 'activated', sha256: originalDigest, byteLength: bytes.length,
    mediaType: 'image/png', width: 16, height: 24 }, async () => originalDigest);
  const revision = await media.recordAssetRevision(upload.upload), readUpload = await media.readUpload(upload.upload);
  const useInput = { target, context: DEFAULT_MEDIA_CONTEXT, asset: upload.asset, variant: assetVariant(upload.asset),
    revision: revision.revision, representation: readUpload!.representation!, occurrence: randomUUID(), role };
  const registered = await access.register({ principal: a.principal, actingSubject: a.actor, scope: `media:avatar:${target}`,
    action: 'media.avatar', idempotencyKey: randomUUID(), requestDigest: sha(JSON.stringify(useInput)) });
  await access.claim(registered.id, registered.requestDigest, a.principal);
  const admission = { admissionId: registered.id, principalId: a.principalId, actingSubject: a.actor,
    authorityEpoch: registered.authorityEpoch, requestDigest: registered.requestDigest };
  const use = await media.createImportedArtUse(admission, useInput);
  const receipt = `urn:rezics:receipt:${sha(`${registered.id}\0media-avatar`)}`;
  await access.recordGraphOutcome(registered.id, { outcome: 'succeeded', receipt, admissionId: registered.id,
    requestDigest: registered.requestDigest, authorityEpoch: registered.authorityEpoch, scope: `media:avatar:${target}`,
    dataEpoch: use.position.dataEpoch, sequence: use.position.sequence });
  const native: ImportedArtNativeBasis = { kind: 'media-use', target, component: `${ID}${use.id}`,
    revision: `${ID}${useInput.revision}`, receipt, variant: useInput.variant, role, context: useInput.context };
  return { ...a, provenance, observation, use, native, useInput, admission, registered, upload, bytes };
}

async function assessment(a: Awaited<ReturnType<typeof artwork>>): Promise<AssessmentInput> {
  await grantFixtureAuthority(f.pool, { scope: ASSESS_SCOPE, requireDispatch: true,
    representations: [{ principalId: a.principalId, actor: a.actor, action: ASSESS_ACTION, lifetime: 'infinity' }],
    grant: { actor: a.actor, action: ASSESS_ACTION, lifetime: 'infinity' } });
  return { actingSubject: a.actor, material: importedArtMaterial(a.provenance), family: 'data_rights',
    useKind: 'media_delivery', useScope: 'rezics:public-media', expressionKind: 'media', basis: 'permission', outcome: 'supported',
    licenseInstrument: null, exceptionKind: null, rationale: 'Synthetic owner-test artwork permission',
    extent: { originalDigest: a.provenance.originalDigest, observationDigest: a.provenance.source.observationDigest,
      fieldLocator: a.provenance.source.fieldLocator }, evidence: {}, obligations: [], expectedAssessment: null, idempotencyKey: randomUUID() };
}
const verifier = () => new ImportedArtNativeVerifier(media, access, new SourceCoverEvidenceVerifier(intake, f.pool), f.objects,
  { source, rights });

test('VNDB portrait and screenshot COPY custody becomes an exact native Use, with role-aware delivery metadata', async () => {
  for (const role of ['portrait', 'screenshot'] as const) {
    const a = await artwork(role);
    expect(await media.createImportedArtUse(a.admission, a.useInput)).toMatchObject({ id: a.use.id, replayed: true });
    expect(await media.itemDelivery(a.use.id!)).toMatchObject({ target: a.native.target, representation: a.useInput.representation });
    const metadata = (await media.presentation.metadata([{ representation: a.useInput.representation, use: a.use.id! }]))[0]!;
    expect(metadata.metadata.coverCredit?.permittedRole).toBe(role);
    expect(metadata.importedArt).toEqual(a.provenance);
    expect(metadata.metadata.coverCredit?.source?.identity).toEqual({ record: a.provenance.source.record,
      component: a.provenance.source.component, observation: a.provenance.source.observation,
      fieldLocator: a.provenance.source.fieldLocator });
    const { coverCredit, ...presentation } = metadata.metadata;
    expect(JSON.stringify(presentation)).not.toMatch(/archive_admission|byteDigest|fieldLocator/);
    expect(JSON.stringify(coverCredit)).not.toMatch(/archive_admission|byteDigest|observationDigest|datasetSnapshotDigest|recordDigest|captureDigest/);
    await source.verifyDelivery(a.provenance);
    const selected = { value: a.provenance.image.captureUrl, language: null };
    expect(await verifier().verify(a.principal, a.native, selected)).toMatchObject({ status: 'unavailable' });
    await rights.assess(a.principal, await assessment(a));
    expect(await verifier().verify(a.principal, { ...a.native, representation: a.useInput.representation }, selected))
      .toMatchObject({ status: 'verified', originalDigest: sha(a.bytes), representationDigest: sha(a.bytes) });
  }
});

test('real imported-art Source, role, revision, representation and current Rights remain independent fences', async () => {
  const a = await artwork('portrait', 'bangumi');
  await expect(source.verifyCurrent(a.principal, { ...a.provenance,
    holderEvidence: { name: 'Invented holder', fieldLocator: '/copyright' } })).rejects.toBeInstanceOf(SourceCoverEvidenceInvalid);
  await source.verifyCurrent(a.principal, { ...a.provenance,
    holderEvidence: { name: 'Test artwork holder', fieldLocator: '/copyright' } });
  await expect(media.createImportedArtUse({ ...a.admission, admissionId: randomUUID() }, { ...a.useInput, role: 'screenshot' }))
    .rejects.toBeInstanceOf(MediaInvalid);
  const input = await assessment(a), assessed = await rights.assess(a.principal, input);
  expect(importedArtDeliveryEligible(a.provenance, await rights.currentMediaDelivery(importedArtMaterial(a.provenance)))).toBe(true);
  expect(importedArtDeliveryEligible({ ...a.provenance, originalDigest: 'a'.repeat(64) },
    await rights.currentMediaDelivery(importedArtMaterial(a.provenance)))).toBe(false);
  await rights.assess(a.principal, { ...input, expectedAssessment: assessed.assessmentId,
    idempotencyKey: randomUUID(), basis: 'unknown', outcome: 'undetermined' });
  expect(importedArtDeliveryEligible(a.provenance, await rights.currentMediaDelivery(importedArtMaterial(a.provenance)))).toBe(false);
  expect(await verifier().verify(a.principal, a.native, { value: a.provenance.image.captureUrl, language: null }))
    .toMatchObject({ status: 'unavailable' });
  await new VerificationStore(f.pool).recordObservationDisposition(a.principalId, randomUUID(),
    a.observation.observation.slice(ID.length), { expectedHead: null, state: 'withdrawn', reason: 'owner test withdrawal' });
  await expect(source.verifyCurrent(a.principal, a.provenance)).rejects.toBeInstanceOf(SourceCoverEvidenceUnavailable);
  await expect(source.verifyDelivery(a.provenance)).rejects.toBeInstanceOf(SourceCoverEvidenceUnavailable);
});


test('shared target authority reconciles the exact artwork command and fences both pending owner paths', async () => {
  const a = await artwork('portrait');
  expect(await sealMediaAdmission(media, a.registered)).toMatchObject({ outcome: 'succeeded',
    receipt: a.native.receipt, dataEpoch: a.use.position.dataEpoch, sequence: a.use.position.sequence });
  const admission = { ...a.admission, admissionId: randomUUID(), requestDigest: sha('cancelled-native-art') };
  const registered: RegisteredAdmission = { ...a.registered, id: admission.admissionId,
    requestDigest: admission.requestDigest, state: 'claimed' };
  expect(await sealMediaAdmission(media, registered)).toMatchObject({ outcome: 'cancelled',
    receipt: `urn:rezics:receipt:${sha(`${admission.admissionId}\0media-avatar`)}` });
  await expect(media.createImportedArtUse(admission, { ...a.useInput, occurrence: randomUUID() }))
    .rejects.toBeInstanceOf(MediaFenced);
  expect(await media.selectAvatar(admission, { target: a.useInput.target, context: DEFAULT_MEDIA_CONTEXT,
    expectedSelection: null, asset: a.upload.asset, crop: null })).toMatchObject({ outcome: 'rejected', id: null });
  expect(await sealMediaAdmission(media, registered)).toMatchObject({ outcome: 'cancelled' });
});
