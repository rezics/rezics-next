import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { ContentCore, migrateContent } from '../../content/src/index.ts';
import { MediaConflict, MediaInvalid, MediaStore, MediaUnavailable } from '../src/modules/media/store.ts';
import { uploadDigest } from '../src/modules/media/commands.ts';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const iri = (id: string) => `https://rezics.com/id/${id}`;
const bytes = (label: string) => Buffer.from(`pinned-cover:${label}`);
let cluster: PostgresCluster | undefined;
let admin: Pool;
let pool: Pool;

interface CoverFixture {
  bytes: Buffer;
  provenance: {
    format: 'media-imported-cover-v1';
    targetWork: string;
    source: {
      record: string;
      component: string | null;
      observation: string;
      provider: string;
      namespace: string;
      externalId: string;
      sourceRevision: string | null;
      observationDigest: string;
      datasetSnapshotDigest: string;
      recordDigest: string;
      fieldLocator: string;
      displayName: string;
      href: string;
    };
    image: { captureUrl: string; captureDigest: string; byteLength: number; mediaType: 'image/png' };
    originalDigest: string;
    holderEvidence: { name: string; fieldLocator: string } | null;
  };
}

async function sourceCover(label: string, options: { sourceRevision?: string | null; component?: boolean } = {}): Promise<CoverFixture> {
  const record = randomUUID();
  const observation = randomUUID();
  const raw = Buffer.from(JSON.stringify({ format: 'source-cover-evidence-v1', label }));
  const sourceRevision = options.sourceRevision === undefined ? `record-${label}` : options.sourceRevision;
  await pool.query(`INSERT INTO source.record (id,provider,namespace,external_id)
    VALUES ($1,'bangumi','subject',$2)`, [record, label]);
  await pool.query(`INSERT INTO source.observation (id,record_id,principal_id,source_revision,media_type,
      retention,raw_bytes,byte_digest,coverage,rights_evidence)
    VALUES ($1,$2,$3,$4,'application/json','retained',$5,$6,$7::jsonb,$8::jsonb)`,
  [observation, record, randomUUID(), sourceRevision, raw, sha(raw),
    JSON.stringify({ scope: 'cover-evidence', complete: false, omittedFields: [] }),
    JSON.stringify({ basis: 'unknown', note: '' })]);
  const image = bytes(label);
  return { bytes: image, provenance: {
    format: 'media-imported-cover-v1',
    targetWork: iri(randomUUID()),
    source: {
      record: iri(record), component: options.component ? iri(randomUUID()) : null,
      observation: iri(observation), provider: 'bangumi', namespace: 'subject', externalId: label,
      sourceRevision, observationDigest: sha(raw), datasetSnapshotDigest: sha(`snapshot:${label}`),
      recordDigest: sha(`record:${label}`), fieldLocator: '/images/common',
      displayName: 'Bangumi', href: `https://bgm.tv/subject/${label}`,
    },
    image: { captureUrl: `https://lain.bgm.tv/pic/cover/${label}.png`,
      captureDigest: sha(image), byteLength: image.byteLength, mediaType: 'image/png' },
    originalDigest: sha(image), holderEvidence: null,
  } };
}

function uploadInput(fixture: CoverFixture, asset: string | null = null) {
  return { asset, mediaType: 'image/png' as const, byteLength: fixture.bytes.byteLength,
    sha256: sha(fixture.bytes), disclosure: 'public' as const, importedCover: fixture.provenance };
}

function admission(input: ReturnType<typeof uploadInput> | ReturnType<typeof ordinaryInput>,
  admissionId = randomUUID(), actingSubject = iri(randomUUID())) {
  return { admissionId, principalId: randomUUID(), actingSubject,
    authorityEpoch: '1', requestDigest: uploadDigest(input) };
}

function ordinaryInput(fixture: CoverFixture, asset: string | null = null) {
  return { asset, mediaType: 'image/png' as const, byteLength: fixture.bytes.byteLength,
    sha256: sha(fixture.bytes), disclosure: 'public' as const };
}

async function storeCover(fixture: CoverFixture, asset: string | null = null) {
  const store = new MediaStore(pool, new ContentCore(pool));
  const input = uploadInput(fixture, asset);
  const actingSubject = iri(randomUUID());
  const reserved = await store.reserveUpload(admission(input, randomUUID(), actingSubject), input);
  const settled = await store.settleUpload(reserved.upload, { status: 'activated', sha256: sha(fixture.bytes),
    byteLength: fixture.bytes.byteLength, mediaType: 'image/png', width: 640, height: 480 });
  const revision = await store.recordAssetRevision(reserved.upload);
  return { store, input, reserved, settled, revision, actingSubject };
}

beforeAll(async () => {
  cluster = await startPostgresCluster();
  admin = new Pool({ ...cluster.connection });
  await admin.query('CREATE DATABASE media_cover_provenance');
  pool = new Pool({ ...cluster.connection, database: 'media_cover_provenance', max: 8 });
  await migrateContent(pool);
});

afterAll(async () => {
  await pool?.end();
  await admin?.end();
  cluster?.remove();
});

test('cover provenance is sealed to the exact asset revision', async () => {
  const fixture = await sourceCover('cover-101', { sourceRevision: null, component: true });
  const saved = await storeCover(fixture);
  const body = (await pool.query<{ body: Record<string, unknown> }>(
    'SELECT body FROM content.revision WHERE id=$1', [saved.revision.revision])).rows[0]!.body;
  const projection = (await pool.query<{ asset_id: string; original_representation_id: string;
    original_digest: string; source_record_id: string; source_component: string | null;
    observation_id: string; observation_digest: string }>(`SELECT asset_id::text,original_representation_id::text,
      original_digest,source_record_id::text,source_component,observation_id::text,observation_digest
    FROM media.imported_cover_revision WHERE asset_revision_id=$1`, [saved.revision.revision])).rows[0];
  expect(body.coverOnly).toBe(true);
  expect(body.importedCover).toEqual(fixture.provenance);
  expect((body.representations as Array<Record<string, unknown>>)[0]).toMatchObject({
    id: saved.settled.representation, sha256: sha(fixture.bytes), role: 'original',
  });
  expect(projection).toEqual({ asset_id: saved.reserved.asset,
    original_representation_id: saved.settled.representation, original_digest: sha(fixture.bytes),
    source_record_id: fixture.provenance.source.record.slice('https://rezics.com/id/'.length),
    source_component: fixture.provenance.source.component,
    observation_id: fixture.provenance.source.observation.slice('https://rezics.com/id/'.length),
    observation_digest: fixture.provenance.source.observationDigest });
  expect(await saved.store.readImportedCoverRevision(saved.revision.revision)).toMatchObject({
    assetRevision: saved.revision.revision, asset: saved.reserved.asset,
    originalRepresentation: saved.settled.representation, originalDigest: sha(fixture.bytes),
    sourceRecord: fixture.provenance.source.record, observation: fixture.provenance.source.observation,
  });
  expect((await pool.query('SELECT cover_only FROM media.asset WHERE id=$1', [saved.reserved.asset]))
    .rows[0]!.cover_only).toBe(true);
  await pool.query("UPDATE media.representation SET availability='erased' WHERE id=$1",
    [saved.settled.representation]);
  expect(await saved.store.readImportedCoverRevision(saved.revision.revision)).toBeNull();
  expect((await pool.query('SELECT count(*)::int AS count FROM media.imported_cover_revision WHERE asset_revision_id=$1',
    [saved.revision.revision])).rows[0]!.count).toBe(0);
});

test('replacement cannot clear imported cover purpose', async () => {
  const first = await storeCover(await sourceCover('cover-201'));
  const secondFixture = await sourceCover('cover-202');
  secondFixture.provenance.targetWork = first.input.importedCover!.targetWork;
  const replacement = uploadInput(secondFixture, first.reserved.asset);
  const denied = ordinaryInput({ ...secondFixture, provenance: first.input.importedCover! }, first.reserved.asset);
  await expect(first.store.reserveUpload(admission(denied, randomUUID(), first.actingSubject), denied))
    .rejects.toBeInstanceOf(MediaInvalid);
  await expect(pool.query('UPDATE media.asset SET cover_only=false WHERE id=$1', [first.reserved.asset]))
    .rejects.toThrow(/immutable media asset identity/);

  const reserved = await first.store.reserveUpload(admission(replacement, randomUUID(), first.actingSubject), replacement);
  await first.store.settleUpload(reserved.upload, { status: 'activated', sha256: sha(secondFixture.bytes),
    byteLength: secondFixture.bytes.byteLength, mediaType: 'image/png', width: 640, height: 480 });
  const revision = await first.store.recordAssetRevision(reserved.upload);
  const body = (await pool.query<{ body: Record<string, unknown> }>(
    'SELECT body FROM content.revision WHERE id=$1', [revision.revision])).rows[0]!.body;
  expect(body.coverOnly).toBe(true);
  expect(body.importedCover).toEqual(secondFixture.provenance);
  expect((await pool.query('SELECT count(*)::int AS count FROM media.imported_cover_revision WHERE asset_id=$1',
    [first.reserved.asset])).rows[0]!.count).toBe(2);
});

test('provenance reconstruction keeps digests and refuses absent evidence', async () => {
  const fixture = await sourceCover('cover-301');
  const content = new ContentCore(pool);
  const store = new MediaStore(pool, content);
  const input = uploadInput(fixture);
  const reserved = await store.reserveUpload(admission(input), input);
  const verdict = { status: 'activated' as const, sha256: sha(fixture.bytes), byteLength: fixture.bytes.byteLength,
    mediaType: 'image/png' as const, width: 640, height: 480 };
  await store.settleUpload(reserved.upload, verdict);

  const save = content.saveDraft.bind(content);
  let loseReply = true;
  content.saveDraft = async command => {
    const result = await save(command);
    if (loseReply) { loseReply = false; throw new Error('simulated lost Content reply'); }
    return result;
  };
  await expect(store.recordAssetRevision(reserved.upload)).rejects.toThrow('simulated lost Content reply');
  const sealed = (await pool.query<{ id: string; body: Record<string, unknown> }>(`SELECT id,body FROM content.revision
    WHERE variant_id=$1 ORDER BY created_at DESC LIMIT 1`, [`urn:rezics:variant:${reserved.asset}`])).rows[0]!;
  expect(await store.readImportedCoverRevision(sealed.id)).toBeNull();
  expect((await store.settleUpload(reserved.upload, verdict)).replayed).toBe(true);
  const replayed = await store.recordAssetRevision(reserved.upload);
  expect(replayed).toEqual({ revision: sealed.id, replayed: true });
  expect(await store.readImportedCoverRevision(sealed.id)).toMatchObject({
    originalDigest: fixture.provenance.originalDigest,
    observationDigest: fixture.provenance.source.observationDigest,
    provenance: { source: { datasetSnapshotDigest: fixture.provenance.source.datasetSnapshotDigest,
      recordDigest: fixture.provenance.source.recordDigest } },
  });

  await pool.query('DELETE FROM media.imported_cover_revision WHERE asset_revision_id=$1', [sealed.id]);
  expect(await store.readImportedCoverRevision(sealed.id)).toBeNull();
  expect(await store.repairImportedCoverProjection(sealed.id)).toBe(true);
  expect(await store.readImportedCoverRevision(sealed.id)).not.toBeNull();

  const observationId = fixture.provenance.source.observation.slice('https://rezics.com/id/'.length);
  await pool.query('ALTER TABLE source.observation DISABLE TRIGGER source_observation_immutable');
  try { await pool.query('DELETE FROM source.observation WHERE id=$1', [observationId]); }
  finally { await pool.query('ALTER TABLE source.observation ENABLE TRIGGER source_observation_immutable'); }
  expect(await store.readImportedCoverRevision(sealed.id)).toBeNull();
  await expect(store.repairImportedCoverProjection(sealed.id)).rejects.toBeInstanceOf(MediaUnavailable);
  expect((await pool.query('SELECT count(*)::int AS count FROM media.imported_cover_revision WHERE asset_revision_id=$1',
    [sealed.id])).rows[0]!.count).toBe(0);
});

test('upload intent rejects a mismatched observation or original digest', async () => {
  const fixture = await sourceCover('cover-401');
  const other = await sourceCover('cover-402');
  const store = new MediaStore(pool, new ContentCore(pool));
  const wrongObservation = { ...fixture.provenance,
    source: { ...fixture.provenance.source, observation: other.provenance.source.observation } };
  const wrongObservationInput = { ...uploadInput(fixture), importedCover: wrongObservation };
  await expect(store.reserveUpload(admission(wrongObservationInput), wrongObservationInput))
    .rejects.toBeInstanceOf(MediaUnavailable);
  const wrongOriginal = { ...fixture.provenance, originalDigest: sha('different-original') };
  const wrongOriginalInput = { ...uploadInput(fixture), importedCover: wrongOriginal };
  await expect(store.reserveUpload(admission(wrongOriginalInput), wrongOriginalInput))
    .rejects.toBeInstanceOf(MediaInvalid);
});

test('same upload key cannot bind altered cover intent', async () => {
  const fixture = await sourceCover('cover-501');
  const store = new MediaStore(pool, new ContentCore(pool));
  const firstInput = uploadInput(fixture);
  const firstAdmission = admission(firstInput);
  const reserved = await store.reserveUpload(firstAdmission, firstInput);
  await expect(pool.query("UPDATE media.upload SET imported_cover_intent='{}'::jsonb WHERE id=$1",
    [reserved.upload])).rejects.toThrow(/invalid media upload transition/);
  const alteredInput = { ...firstInput, importedCover: { ...fixture.provenance,
    source: { ...fixture.provenance.source, fieldLocator: '/images/large' } } };
  const alteredAdmission = { ...firstAdmission, requestDigest: uploadDigest(alteredInput) };
  await expect(store.reserveUpload(alteredAdmission, alteredInput)).rejects.toBeInstanceOf(MediaConflict);
});

test('ordinary non-imported assets keep the legacy manifest and replacement behavior', async () => {
  const fixture = await sourceCover('cover-601');
  const store = new MediaStore(pool, new ContentCore(pool));
  const input = ordinaryInput(fixture);
  const reserved = await store.reserveUpload(admission(input), input);
  await store.settleUpload(reserved.upload, { status: 'activated', sha256: sha(fixture.bytes),
    byteLength: fixture.bytes.byteLength, mediaType: 'image/png', width: 640, height: 480 });
  const revision = await store.recordAssetRevision(reserved.upload);
  const body = (await pool.query<{ body: Record<string, unknown> }>(
    'SELECT body FROM content.revision WHERE id=$1', [revision.revision])).rows[0]!.body;
  expect(body).not.toHaveProperty('coverOnly');
  expect(body).not.toHaveProperty('importedCover');
  expect((await pool.query('SELECT cover_only FROM media.asset WHERE id=$1', [reserved.asset]))
    .rows[0]!.cover_only).toBe(false);
  expect(await store.readImportedCoverRevision(revision.revision)).toBeNull();
  const replacement = ordinaryInput(await sourceCover('cover-602'), reserved.asset);
  const owner = (await pool.query<{ owner: string }>('SELECT owner FROM media.asset WHERE id=$1', [reserved.asset])).rows[0]!.owner;
  expect((await store.reserveUpload(admission(replacement, randomUUID(), owner), replacement)).asset).toBe(reserved.asset);
});
