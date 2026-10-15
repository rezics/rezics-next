import { afterAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { S3ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { SourceCoverEvidenceUnavailable } from '../../../services/main/src/modules/source/cover-evidence.ts';
import { SourceIntakeStore } from '../../../services/main/src/modules/source/intake.ts';
import { avatarImageEligible } from '../../../services/main/src/modules/media/store.ts';
import { readZoneConfiguration } from '../../../services/main/src/modules/zone/configuration.ts';
import { DEFAULT_ZONE_PRESENTATION } from '../../../services/main/src/modules/zone/presentation-format.ts';
import { startMediaStack, type MediaStack } from './media-support.ts';
import { requireQa } from './recommendation-support.ts';
import { cloneQaOwnerDatabases } from '../support/databases.ts';

const ID = 'https://rezics.com/id/';
const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const ref = () => `${ID}${randomUUID()}`;
let started: Promise<MediaStack> | undefined;
const stack = () => started ??= (async () => {
  const owners = await cloneQaOwnerDatabases(requireQa(), ['access', 'content', 'relay'], 'privileged');
  try {
    const fixture = await startMediaStack('source-cover-attachment', { ownerUrls: owners.urls, profileCredits: true });
    return { ...fixture, stop: async () => { try { await fixture.stop(); } finally { await owners.close(); } } };
  } catch (error) { await owners.close(); throw error; }
})();
afterAll(async () => { if (started) await (await started).stop(); });

async function json<T = Record<string, unknown>>(response: Response, expected: number): Promise<T> {
  const body = await response.text();
  expect(response.status, body).toBe(expected);
  return JSON.parse(body) as T;
}

async function image(background = { r: 20, g: 40, b: 60, alpha: 0.5 }) {
  return sharp({ create: { width: 1280, height: 720, channels: 4,
    background } }).png().toBuffer();
}

type SourceEnvelope = {
  profile: 'source-cover-evidence-v1';
  source: {
    provider: string; namespace: string; externalId: string; sourceRevision: string | null;
    component: string | null; datasetSnapshotDigest: string; recordDigest: string;
    fieldLocator: string; displayName: string; href: string;
  };
  image: { captureUrl: string; captureDigest: string; byteLength: number; mediaType: 'image/png' };
  holderEvidence: { name: string; fieldLocator: string } | null;
};

async function coverEvidence(f: MediaStack, principalId: string, targetWork: string,
  bytes: Buffer): Promise<{ importedCover: Record<string, unknown>; sourceRecord: string; sourceObservation: string }> {
  const externalId = `subject-${randomUUID()}`;
  const sourceRevision = `snapshot-${randomUUID()}`;
  const imageDigest = sha(bytes);
  const envelope: SourceEnvelope = {
    profile: 'source-cover-evidence-v1',
    source: { provider: 'bangumi', namespace: 'subject', externalId, sourceRevision, component: null,
      datasetSnapshotDigest: sha(`dataset:${externalId}`), recordDigest: sha(`record:${externalId}`),
      fieldLocator: '/images/common', displayName: 'Bangumi', href: `https://bgm.tv/subject/${externalId}` },
    image: { captureUrl: `https://lain.bgm.tv/pic/cover/${externalId}.png`, captureDigest: imageDigest,
      byteLength: bytes.length, mediaType: 'image/png' },
    holderEvidence: null,
  };
  const raw = Buffer.from(JSON.stringify(envelope));
  const intake = new SourceIntakeStore(f.contentPool);
  const saved = await intake.submit(principalId, `cover-evidence-${randomUUID()}`, {
    provider: envelope.source.provider, namespace: envelope.source.namespace, externalId,
    sourceRevision, mediaType: 'application/json', retention: 'retained', rawBytesBase64: raw.toString('base64'),
    coverage: { scope: 'cover-evidence', complete: false, omittedFields: ['description'] },
    rightsEvidence: { basis: 'unknown', note: '' },
  });
  const observation = saved.observation;
  expect(observation.byteDigest).toBe(sha(raw));
  expect(observation.byteDigest).not.toBe(imageDigest);
  return { sourceRecord: observation.record, sourceObservation: observation.observation,
    importedCover: { format: 'media-imported-cover-v1', targetWork,
      source: { record: observation.record, component: null, observation: observation.observation,
        ...envelope.source, observationDigest: observation.byteDigest },
      image: envelope.image, originalDigest: imageDigest, holderEvidence: null } };
}

async function addLargeObservationHistory(f: MediaStack, principalId: string,
  importedCover: Record<string, unknown>) {
  const provenance = importedCover as { source: { provider: string; namespace: string; externalId: string } };
  const intake = new SourceIntakeStore(f.contentPool);
  const largePart = Buffer.from(JSON.stringify({ kind: 'fact-record-part', body: 'x'.repeat(48_000) }));
  for (let index = 0; index < 12; index++) {
    await intake.submit(principalId, `large-subject-part-${index}-${randomUUID()}`, {
      provider: provenance.source.provider, namespace: provenance.source.namespace,
      externalId: provenance.source.externalId, sourceRevision: `part-${index}`,
      mediaType: 'application/json', retention: 'retained', rawBytesBase64: largePart.toString('base64'),
      coverage: { scope: `part-${index}`, complete: false, omittedFields: [] },
      rightsEvidence: { basis: 'unknown', note: '' },
    });
  }
}

async function reserveCover(f: MediaStack, owner: Awaited<ReturnType<MediaStack['member']>>,
  bytes: Buffer, importedCover: Record<string, unknown>, key = `cover-${randomUUID()}`) {
  const response = await owner.send('POST', '/v1/media/uploads', {
    profile: 'media-image-upload-v1', asset: null, mediaType: 'image/png', byteLength: bytes.length,
    sha256: sha(bytes), disclosure: 'public', actingSubject: owner.actor, importedCover,
  }, key);
  const reservation = await json<{ asset: string; upload: string; uploadUrl: string }>(response, 201);
  return { reservation, key };
}

async function transfer(f: MediaStack, owner: Awaited<ReturnType<MediaStack['member']>>,
  upload: string, bytes: Buffer) {
  return f.call('PUT', `/v1/media/uploads/${upload}/bytes`, { token: owner.token, raw: bytes });
}

async function spaceAndZone(f: MediaStack, owner: Awaited<ReturnType<MediaStack['member']>>, label: string) {
  const structures = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!, bucket: Bun.env.MAIN_S3_BUCKET!,
    region: Bun.env.MAIN_S3_REGION!, accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
    prefix: 'semantic/structure/' });
  await structures.initialize();
  (f.env as typeof f.env & { structureObjects: S3ImmutableObjects }).structureObjects = structures;
  await owner.grant('space:create:root', 'space.create');
  const space = await json<{ space: string; realm: string }>(await owner.send('POST', '/v1/spaces', {
    profile: 'space-realm-v1', name: label, capabilities: ['realm'], actingSubject: owner.actor,
  }), 201);
  const zone = ref();
  await owner.grant(`zone:edit:${zone}`, 'zone.edit');
  await json(await owner.send('POST', '/v1/zones', { zone, space: space.space,
    disclosure: 'public', actingSubject: owner.actor }), 201);
  return { ...space, zone, path: `/v1/zones/${zone.slice(ID.length)}` };
}

test('COVER-BIND checks exact principal-owned evidence before reserve and replays an interrupted transfer', async () => {
  const f = await stack();
  const owner = await f.member('cover-bind-owner');
  const stranger = await f.member('cover-bind-stranger');
  const work = await f.publicWork(owner.actor);
  const bytes = await image();
  const evidence = await coverEvidence(f, owner.principalId, work.work, bytes);
  await addLargeObservationHistory(f, owner.principalId, evidence.importedCover);
  const sourceRecord = evidence.sourceRecord.slice(ID.length);
  expect((await f.contentPool.query('SELECT count(*)::int AS n FROM source.observation WHERE record_id=$1',
    [sourceRecord])).rows[0]?.n).toBe(13);

  const key = `cover-reserve-${randomUUID()}`;
  const admitted = await reserveCover(f, owner, bytes, evidence.importedCover, key);
  const replay = await json<{ upload: string; asset: string }>(await owner.send('POST', '/v1/media/uploads', {
    profile: 'media-image-upload-v1', asset: null, mediaType: 'image/png', byteLength: bytes.length,
    sha256: sha(bytes), disclosure: 'public', actingSubject: owner.actor, importedCover: evidence.importedCover,
  }, key), 200);
  expect(replay).toMatchObject({ upload: admitted.reservation.upload, asset: admitted.reservation.asset });
  const changed = structuredClone(evidence.importedCover) as { source: { fieldLocator: string } };
  changed.source.fieldLocator = '/images/large';
  expect(await json(await owner.send('POST', '/v1/media/uploads', {
    profile: 'media-image-upload-v1', asset: null, mediaType: 'image/png', byteLength: bytes.length,
    sha256: sha(bytes), disclosure: 'public', actingSubject: owner.actor, importedCover: changed,
  }, key), 409)).toMatchObject({ code: 'idempotency_conflict' });

  const transferred = await json<{ asset: string; representation: string; revision: string }>(
    await transfer(f, owner, admitted.reservation.upload, bytes), 201);
  const transferReplay = await json<{ asset: string; representation: string; revision: string; replayed: boolean }>(
    await transfer(f, owner, admitted.reservation.upload, bytes), 200);
  expect(transferReplay).toMatchObject({ asset: transferred.asset, representation: transferred.representation,
    revision: transferred.revision, replayed: true });
  expect((await f.contentPool.query('SELECT count(*)::int AS n FROM media.representation WHERE upload_id=$1',
    [admitted.reservation.upload])).rows[0]?.n).toBe(1);

  const unavailableSource = await stranger.send('POST', '/v1/media/uploads', {
    profile: 'media-image-upload-v1', asset: null, mediaType: 'image/png', byteLength: bytes.length,
    sha256: sha(bytes), disclosure: 'public', actingSubject: stranger.actor, importedCover: evidence.importedCover,
  });
  await json(unavailableSource, 400);
  expect((await f.contentPool.query(`SELECT count(*)::int AS n FROM media.upload u JOIN media.asset a ON a.id=u.asset_id
    WHERE a.owner=$1 AND u.imported_cover_intent->'source'->>'observation'=$2`,
  [stranger.actor, evidence.sourceObservation])).rows[0]?.n).toBe(0);
});

test('COVER-BIND rejects altered or missing retained descriptors before creating media state', async () => {
  const f = await stack();
  const owner = await f.member('cover-bind-invalid');
  const work = await f.publicWork(owner.actor);
  const bytes = await image();
  const evidence = await coverEvidence(f, owner.principalId, work.work, bytes);
  const altered = structuredClone(evidence.importedCover) as { source: { fieldLocator: string } };
  altered.source.fieldLocator = '/images/large';
  await json(await owner.send('POST', '/v1/media/uploads', { profile: 'media-image-upload-v1', asset: null,
    mediaType: 'image/png', byteLength: bytes.length, sha256: sha(bytes), disclosure: 'public',
    actingSubject: owner.actor, importedCover: altered }), 400);
  const absent = structuredClone(evidence.importedCover) as { source: { observation: string } };
  absent.source.observation = ref();
  await json(await owner.send('POST', '/v1/media/uploads', { profile: 'media-image-upload-v1', asset: null,
    mediaType: 'image/png', byteLength: bytes.length, sha256: sha(bytes), disclosure: 'public',
    actingSubject: owner.actor, importedCover: absent }), 400);
  expect((await f.contentPool.query(`SELECT count(*)::int AS n FROM media.upload u JOIN media.asset a ON a.id=u.asset_id
    WHERE a.owner=$1 AND u.imported_cover_intent->'source'->>'record'=$2`,
  [owner.actor, evidence.sourceRecord])).rows[0]?.n).toBe(0);

  const routeMedia = f.composition.dependencies.media!;
  const originalVerifier = routeMedia.sourceCoverEvidence;
  routeMedia.sourceCoverEvidence = { verify: async () => { throw new SourceCoverEvidenceUnavailable('interrupted read'); } };
  try {
    await json(await owner.send('POST', '/v1/media/uploads', { profile: 'media-image-upload-v1', asset: null,
      mediaType: 'image/png', byteLength: bytes.length, sha256: sha(bytes), disclosure: 'public',
      actingSubject: owner.actor, importedCover: evidence.importedCover }), 503);
  } finally { routeMedia.sourceCoverEvidence = originalVerifier; }
  expect((await f.contentPool.query(`SELECT count(*)::int AS n FROM media.upload u JOIN media.asset a ON a.id=u.asset_id
    WHERE a.owner=$1 AND u.imported_cover_intent->'source'->>'record'=$2`,
  [owner.actor, evidence.sourceRecord])).rows[0]?.n).toBe(0);
});

test('COVER-ROLE confines an imported cover to its Work avatar and keeps other image roles open', async () => {
  const f = await stack();
  const owner = await f.member('cover-role-owner');
  const work = await f.publicWork(owner.actor);
  const otherWork = await f.publicWork(owner.actor);
  const bytes = await image();
  const evidence = await coverEvidence(f, owner.principalId, work.work, bytes);
  const { reservation } = await reserveCover(f, owner, bytes, evidence.importedCover);
  const admitted = await json<{ asset: string; representation: string; revision: string }>(
    await transfer(f, owner, reservation.upload, bytes), 201);
  const avatarPath = (target: string) => `/v1/resources/${target.slice(ID.length)}/avatar`;
  await owner.grant(`media:avatar:${work.work}`, 'media.avatar');
  const avatarBody = { profile: 'resource-avatar-selection-v1', expectedSelection: null,
    asset: admitted.asset, actingSubject: owner.actor };
  const selection = await json<{ selection: string }>(await owner.send('PUT', avatarPath(work.work), avatarBody), 201);
  expect((await f.contentPool.query(`SELECT u.target,u.role,u.asset_revision_id FROM media.use u
    JOIN media.selection_revision r ON r.use_id=u.id WHERE r.id=$1`, [selection.selection])).rows[0])
    .toMatchObject({ target: work.work, role: 'avatar', asset_revision_id: admitted.revision });
  const summaryResponse = await owner.send('POST', '/v1/resources/summaries', {
    profile: 'resource-summary-batch-v1', resources: [work.work], actingSubject: owner.actor,
  });
  expect(summaryResponse.status).toBe(200);
  const summaries = await summaryResponse.json() as { summaries: { avatar: { kind: string; use?: string } }[] };
  const coverUse = summaries.summaries[0]!.avatar.use;
  if (!coverUse) throw new Error('Selected avatar has no delivered Use');
  const movedEvidence = await coverEvidence(f, owner.principalId, otherWork.work, bytes);
  await json(await owner.send('POST', '/v1/media/uploads', { profile: 'media-image-upload-v1',
    asset: admitted.asset, mediaType: 'image/png', byteLength: bytes.length, sha256: sha(bytes),
    disclosure: 'public', actingSubject: owner.actor, importedCover: movedEvidence.importedCover }), 400);

  await json(await owner.send('PUT', avatarPath(work.work), avatarBody), 409);
  await owner.grant(`media:avatar:${otherWork.work}`, 'media.avatar');
  await json(await owner.send('PUT', avatarPath(otherWork.work), { ...avatarBody, expectedSelection: null }), 403);
  await owner.grant(`media:avatar:${owner.actor}`, 'media.avatar');
  await json(await owner.send('PUT', avatarPath(owner.actor), { ...avatarBody, expectedSelection: null }), 403);

  const concurrency = await Promise.all([
    owner.send('PUT', avatarPath(work.work), { ...avatarBody, expectedSelection: selection.selection },
      `cover-race-a-${randomUUID()}`),
    owner.send('PUT', avatarPath(work.work), { ...avatarBody, expectedSelection: selection.selection },
      `cover-race-b-${randomUUID()}`),
  ]);
  expect(concurrency.map(response => response.status).sort()).toEqual([201, 409]);

  await owner.grant(`content:publish:${work.work}`, 'media.use');
  await json(await owner.send('POST', '/v1/media/uses', { actingSubject: owner.actor, target: work.work,
    representation: admitted.representation, occurrence: randomUUID() }), 404);
  await owner.grant(`content:draft:${work.work}`, 'content.draft');
  const variant = `urn:rezics:variant:${randomUUID()}`;
  await json(await owner.send('POST', '/v1/media/publications', { profile: 'media-set-v1',
    resourceId: work.work, variantId: variant, expectedHead: null, assets: [admitted.asset],
    actingSubject: owner.actor }), 404);
  await owner.grant(`media:avatar:${work.work}`, 'media.avatar');
  await json(await owner.send('PUT', `/v1/resources/${work.work.slice(ID.length)}/showcase/art`, {
    profile: 'work-showcase-selection-v1', expectedSelection: null, asset: admitted.asset,
    role: 'background-landscape', crop: null, focalArea: null, actingSubject: owner.actor,
  }), 404);

  const zone = await spaceAndZone(f, owner, `cover-role-${randomUUID()}`);
  await json(await owner.send('POST', `${zone.path}/campaign-art`, { profile: 'zone-campaign-art-v1',
    realm: zone.realm, asset: admitted.asset, role: 'background-landscape', actingSubject: owner.actor }), 404);
  const zoneHead = await readZoneConfiguration(f.env, zone.zone);
  await json(await owner.send('PUT', `${zone.path}/configuration`, {
    expectedHead: zoneHead.revision, defaultRealm: zone.realm,
    presentation: { ...DEFAULT_ZONE_PRESENTATION, slides: [{ id: 'cover-banner', href: '/cover',
      title: 'Cover banner', art: { landscape: { use: `${ID}${coverUse}` } } }] },
    actingSubject: owner.actor,
  }), 200);
  const banner = await json<{ slideMedia: Array<{ art: { landscape: unknown } }> }>(
    await f.call('GET', `${zone.path}/presentation`), 200);
  expect(banner.slideMedia[0]?.art.landscape).toBeNull();

  const ordinary = await owner.upload(bytes);
  const ordinarySelection = await json<{ selection: string }>(await owner.send('PUT',
    `/v1/resources/${work.work.slice(ID.length)}/showcase/art`, { profile: 'work-showcase-selection-v1',
      expectedSelection: null, asset: ordinary.asset, role: 'background-landscape', crop: null,
      focalArea: null, actingSubject: owner.actor }), 201);
  expect(ordinarySelection.selection).toBeTruthy();
});

test('COVER-SUPPRESSION refuses suppressed imported bytes until the notice lift restores them', async () => {
  const f = await stack();
  const owner = await f.member('cover-suppression-owner');
  const work = await f.publicWork(owner.actor);
  const bytes = await image({ r: 38, g: 117, b: 201, alpha: 1 });
  const evidence = await coverEvidence(f, owner.principalId, work.work, bytes);
  const { reservation } = await reserveCover(f, owner, bytes, evidence.importedCover);
  const imported = await json<{ asset: string; representation: string; revision: string }>(
    await transfer(f, owner, reservation.upload, bytes), 201);
  const suppression = { id: randomUUID(), caseId: randomUUID(), decisionId: randomUUID() };
  expect(await f.store.suppressIdenticalCopies(sha(bytes), null, 100, suppression))
    .toMatchObject({ suppressed: 1, continuation: null });

  const before = (await f.contentPool.query<{ n: number }>(`SELECT count(*)::int AS n FROM media.upload
    WHERE declared_digest=$1`, [sha(bytes)])).rows[0]!.n;
  await json(await owner.send('POST', '/v1/media/uploads', { profile: 'media-image-upload-v1', asset: null,
    mediaType: 'image/png', byteLength: bytes.length, sha256: sha(bytes), disclosure: 'public',
    actingSubject: owner.actor, importedCover: evidence.importedCover }), 403);

  const otherRecord = await coverEvidence(f, owner.principalId, work.work, bytes);
  await json(await owner.send('POST', '/v1/media/uploads', { profile: 'media-image-upload-v1', asset: null,
    mediaType: 'image/png', byteLength: bytes.length, sha256: sha(bytes), disclosure: 'public',
    actingSubject: owner.actor, importedCover: otherRecord.importedCover }), 403);
  expect((await f.contentPool.query<{ n: number }>(`SELECT count(*)::int AS n FROM media.upload
    WHERE declared_digest=$1`, [sha(bytes)])).rows[0]!.n).toBe(before);

  const unrelated = await image({ r: 200, g: 10, b: 90, alpha: 1 });
  const unrelatedEvidence = await coverEvidence(f, owner.principalId, work.work, unrelated);
  const accepted = await reserveCover(f, owner, unrelated, unrelatedEvidence.importedCover);
  expect(accepted.reservation.upload).toBeTruthy();

  const state = await f.store.readAsset(imported.asset);
  expect(state?.moderation).toBe('suppressed');
  const lift = { ...suppression, decisionId: randomUUID(), reversesDecisionId: suppression.decisionId };
  await f.store.moderateOriginal(`cover-notice-lift:${lift.decisionId}`, imported.representation,
    state!.state, false, lift);
  expect(await f.store.restoreIdenticalCopies(lift)).toMatchObject({ restored: 0, continuation: null });
  const restored = await reserveCover(f, owner, bytes, evidence.importedCover);
  expect(restored.reservation.upload).toBeTruthy();
});

test('COVER-REPLACEMENT gives an independent avatar upload a new Asset that survives the imported Asset takedown', async () => {
  const f = await stack();
  const owner = await f.member('cover-replacement-owner');
  const work = await f.publicWork(owner.actor);
  const originalBytes = await image({ r: 51, g: 164, b: 23, alpha: 0.8 });
  const evidence = await coverEvidence(f, owner.principalId, work.work, originalBytes);
  const { reservation } = await reserveCover(f, owner, originalBytes, evidence.importedCover);
  const imported = await json<{ asset: string; representation: string; revision: string }>(
    await transfer(f, owner, reservation.upload, originalBytes), 201);
  const avatarPath = `/v1/resources/${work.work.slice(ID.length)}/avatar`;
  await owner.grant(`media:avatar:${work.work}`, 'media.avatar');
  const first = await json<{ selection: string }>(await owner.send('PUT', avatarPath, {
    profile: 'resource-avatar-selection-v1', expectedSelection: null, asset: imported.asset,
    actingSubject: owner.actor,
  }), 201);

  const replacementBytes = await image({ r: 230, g: 90, b: 15, alpha: 1 });
  const replacement = await owner.upload(replacementBytes);
  expect(replacement.asset).not.toBe(imported.asset);
  const selected = await json<{ selection: string }>(await owner.send('PUT', avatarPath, {
    profile: 'resource-avatar-selection-v1', expectedSelection: first.selection,
    asset: replacement.asset, actingSubject: owner.actor,
  }), 201);

  await f.store.suppressIdenticalCopies(sha(originalBytes));
  expect((await f.store.readAsset(imported.asset))?.moderation).toBe('suppressed');
  const current = await f.store.avatarSelection(selected.selection);
  expect(current).toMatchObject({ asset: replacement.asset, moderation: 'none', clearance: 'cleared' });
  expect(avatarImageEligible(current!)).toBe(true);
  expect((await f.call('GET', `/v1/media/avatars/${selected.selection}`)).status).toBe(200);
});
