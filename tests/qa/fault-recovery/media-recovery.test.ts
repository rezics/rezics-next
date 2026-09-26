import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { avatarDigest, sealMediaAdmission } from '../../../services/main/src/modules/media/commands.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../../../services/main/src/modules/media/store.ts';
import { png, sha, startMediaStack, type MediaStack } from '../integration/media-support.ts';

let started: Promise<MediaStack> | undefined;
const stack = () => started ??= startMediaStack('media-recovery');
afterAll(async () => { if (started) await (await started).stop(); });

test('VIEW08 recovery: a lost asset-revision stage, a moved head and fenced or lost responses settle once', async () => {
  const { member, publicWork, store, contentPool, access, objects, call } = await stack();
  const owner = await member('recovering');
  const work = await publicWork(owner.actor);
  const target = work.work.slice('https://rezics.com/id/'.length);

  // Crash after activation, before the Content revision stage: bytes and representation exist, no head.
  const bytes = png(40, 40);
  const reserved = await owner.send('POST', '/v1/media/uploads', { profile: 'media-image-upload-v1', asset: null,
    mediaType: 'image/png', byteLength: bytes.length, sha256: sha(bytes), disclosure: 'public',
    actingSubject: owner.actor });
  const { asset, upload, objectNamespace } = await reserved.json() as { asset: string; upload: string;
    objectNamespace: string };
  await objects(objectNamespace).put(bytes);
  const activated = await store.settleUpload(upload, { status: 'activated', sha256: sha(bytes),
    byteLength: bytes.length, mediaType: 'image/png', width: 40, height: 40 });
  expect(activated.status).toBe('activated');
  const headOf = async () => (await contentPool.query<{ draft_head: string | null }>(
    'SELECT draft_head FROM content.variant WHERE id = $1', [`urn:rezics:variant:${asset}`])).rows[0]?.draft_head ?? null;
  expect(await headOf()).toBeNull();
  expect(await store.unrecordedActivations(1000)).toContain(upload);

  // Reconciliation records exactly one revision; repeating it and retrying the transfer replay it.
  const recorded = await store.recordAssetRevision(upload);
  expect(await store.recordAssetRevision(upload)).toEqual({ revision: recorded.revision, replayed: true });
  expect(await headOf()).toBe(recorded.revision);
  expect(await store.unrecordedActivations(1000)).not.toContain(upload);
  const retried = await call('PUT', `/v1/media/uploads/${upload}/bytes`, { token: owner.token, raw: bytes });
  expect(retried.status).toBe(200);
  expect(await retried.json()).toMatchObject({ revision: recorded.revision, replayed: true });

  // A head moved by a concurrent activation: the lost stage retries under a derived operation.
  const later = png(41, 41);
  const next = await owner.send('POST', '/v1/media/uploads', { profile: 'media-image-upload-v1', asset,
    mediaType: 'image/png', byteLength: later.length, sha256: sha(later), disclosure: 'public',
    actingSubject: owner.actor });
  const nextUpload = (await next.json() as { upload: string }).upload;
  await objects(objectNamespace).put(later);
  await store.settleUpload(nextUpload, { status: 'activated', sha256: sha(later), byteLength: later.length,
    mediaType: 'image/png', width: 41, height: 41 });
  const other = await owner.upload(png(42, 42), 'public', asset);
  expect(await headOf()).toBe(other.revision);
  const moved = await store.recordAssetRevision(nextUpload);
  expect(await headOf()).toBe(moved.revision);
  const attempts = await contentPool.query<{ operation_id: string; outcome: string }>(
    `SELECT operation_id, outcome FROM content.receipt WHERE operation_id LIKE $1 ORDER BY sequence`,
    [`media-asset-revision:${nextUpload}%`]);
  expect(attempts.rows.map(row => row.outcome)).toEqual(['succeeded']);

  // A claimed admission fenced by Access before dispatch is cancelled once and never applies later.
  await owner.grant(`media:avatar:${work.work}`, 'media.avatar');
  const selection = { target: work.work, context: DEFAULT_MEDIA_CONTEXT, expectedSelection: null, asset,
    crop: null };
  const fencedKey = `fenced-${randomUUID()}`;
  const registered = await access.register({ principal: owner.principal, actingSubject: owner.actor,
    scope: `media:avatar:${work.work}`, action: 'media.avatar', idempotencyKey: fencedKey,
    requestDigest: avatarDigest(selection) });
  await access.claim(registered.id, avatarDigest(selection));
  const sealed = await sealMediaAdmission(store, registered);
  expect(sealed.outcome).toBe('cancelled');
  expect((await sealMediaAdmission(store, registered)).sequence).toBe(sealed.sequence);
  const late = await owner.send('PUT', `/v1/resources/${target}/avatar`, { profile: 'resource-avatar-selection-v1',
    expectedSelection: null, asset, actingSubject: owner.actor }, fencedKey);
  expect(late.status).toBe(403);
  expect((await contentPool.query('SELECT head FROM media.selection_slot WHERE target = $1', [work.work]))
    .rows[0]?.head ?? null).toBeNull();

  // A lost success response replays the owner outcome even after Access closes dispatch.
  const key = `lost-${randomUUID()}`;
  const body = { profile: 'resource-avatar-selection-v1', expectedSelection: null, asset, actingSubject: owner.actor };
  const applied = await owner.send('PUT', `/v1/resources/${target}/avatar`, body, key);
  expect(applied.status).toBe(201);
  const head = (await applied.json() as { selection: string }).selection;
  const gate = await access.strongCloseScope(`media:avatar:${work.work}`, '0');
  expect(gate.authorityEpoch).not.toBe('0');
  const replayed = await owner.send('PUT', `/v1/resources/${target}/avatar`, body, key);
  expect(replayed.status).toBe(200);
  expect(await replayed.json()).toMatchObject({ selection: head, replayed: true });
  const fresh = await owner.send('PUT', `/v1/resources/${target}/avatar`, { ...body, expectedSelection: head });
  expect(fresh.status).toBe(403);
}, 180_000);
