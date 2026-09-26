import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { png, sha, startMediaStack, type MediaStack } from './media-support.ts';

let started: Promise<MediaStack> | undefined;
const stack = () => started ??= startMediaStack('media-api');
afterAll(async () => { if (started) await (await started).stop(); });

test('VIEW08 template: an avatar image travels reservation, RustFS activation and a CAS selection with exact receipts', async () => {
  const { member, publicWork, call, contentPool, objects, accessPool } = await stack();
  const owner = await member('owner');
  const outsider = await member('outsider');
  const work = await publicWork(owner.actor);
  const bytes = png(256, 256);
  const reservation = { profile: 'media-image-upload-v1', asset: null, mediaType: 'image/png',
    byteLength: bytes.length, sha256: sha(bytes), disclosure: 'public', actingSubject: owner.actor };

  // Denied: the outsider holds no grant for the owner's media scope; nothing is written.
  const before = await contentPool.query("SELECT count(*)::int AS n FROM content.receipt WHERE action LIKE 'media.%'");
  const denied = await outsider.send('POST', '/v1/media/uploads', { ...reservation, actingSubject: owner.actor });
  expect(denied.status).toBe(403);
  const after = await contentPool.query("SELECT count(*)::int AS n FROM content.receipt WHERE action LIKE 'media.%'");
  expect(after.rows[0].n).toBe(before.rows[0].n);

  // Idempotent reservation: same key replays; the same key with another body conflicts.
  const key = `reserve-${randomUUID()}`;
  const reserved = await owner.send('POST', '/v1/media/uploads', reservation, key);
  expect(reserved.status).toBe(201);
  const first = await reserved.json() as { asset: string; upload: string; stateHead: string;
    quarantineKey: string; objectNamespace: string; replayed: boolean };
  expect(first).toMatchObject({ replayed: false, objectNamespace: `media/asset/${first.asset}/`,
    quarantineKey: `media-quarantine/${first.upload}` });
  const replayed = await owner.send('POST', '/v1/media/uploads', reservation, key);
  expect(replayed.status).toBe(200);
  expect(await replayed.json()).toMatchObject({ asset: first.asset, upload: first.upload, replayed: true });
  const conflict = await owner.send('POST', '/v1/media/uploads', { ...reservation, disclosure: 'private' }, key);
  expect(conflict.status).toBe(409);

  // Declared bytes are enforced: wrong length and wrong format are durable rejections.
  const short = await call('PUT', `/v1/media/uploads/${first.upload}/bytes`, { token: owner.token,
    raw: bytes.subarray(1) });
  expect(short.status).toBe(422);
  expect(await short.json()).toMatchObject({ status: 'rejected', reason: 'size-mismatch' });
  const again = await call('PUT', `/v1/media/uploads/${first.upload}/bytes`, { token: owner.token, raw: bytes });
  expect(again.status).toBe(422);
  expect(await again.json()).toMatchObject({ status: 'rejected', reason: 'size-mismatch' });
  const notImage = new Uint8Array(bytes.length).fill(7);
  const fake = await owner.send('POST', '/v1/media/uploads', { ...reservation, sha256: sha(notImage) });
  const fakeUpload = (await fake.json() as { upload: string }).upload;
  const rejected = await call('PUT', `/v1/media/uploads/${fakeUpload}/bytes`, { token: owner.token, raw: notImage });
  expect(await rejected.json()).toMatchObject({ status: 'rejected', reason: 'format-rejected' });

  // Only the reserving principal may transfer bytes.
  const second = await owner.send('POST', '/v1/media/uploads', { ...reservation, asset: first.asset });
  expect(second.status).toBe(201);
  const upload = (await second.json() as { upload: string }).upload;
  const foreign = await call('PUT', `/v1/media/uploads/${upload}/bytes`, { token: outsider.token, raw: bytes });
  expect(foreign.status).toBe(404);
  const activated = await call('PUT', `/v1/media/uploads/${upload}/bytes`, { token: owner.token, raw: bytes });
  expect(activated.status).toBe(201);
  const active = await activated.json() as { asset: string; representation: string; revision: string };
  const retried = await call('PUT', `/v1/media/uploads/${upload}/bytes`, { token: owner.token, raw: bytes });
  expect(retried.status).toBe(200);
  expect(await retried.json()).toMatchObject({ representation: active.representation, revision: active.revision,
    replayed: true });

  // Exact bytes live in the asset namespace on RustFS; quarantine held the staged copy.
  expect(sha(await objects(`media/asset/${first.asset}/`).get(sha(bytes)))).toBe(sha(bytes));
  expect(sha(await objects(`media-quarantine/${upload}/`).get(sha(bytes)))).toBe(sha(bytes));
  const revision = await contentPool.query(`SELECT model, predecessor, body FROM content.revision WHERE id = $1`,
    [active.revision]);
  expect(revision.rows[0]).toMatchObject({ model: 'media-asset-v1', predecessor: null,
    body: { profile: 'media-asset-v1', representations: [{ id: active.representation, sha256: sha(bytes),
      width: 256, height: 256 }] } });
  const actions = await contentPool.query<{ action: string; outcome: string }>(`SELECT action, outcome
    FROM content.receipt r JOIN content.outbox o USING (operation_id)
    WHERE r.operation_id = ANY($1::text[]) ORDER BY r.sequence`,
  [[`media-activate:${upload}`, `media-activate:${first.upload}`]]);
  expect(actions.rows).toEqual([{ action: 'media.upload.settle', outcome: 'rejected' },
    { action: 'media.upload.settle', outcome: 'succeeded' }]);

  // Avatar selection: target authority, explicit-null CAS, replay and stale outcome.
  const target = work.work.slice('https://rezics.com/id/'.length);
  const selection = { profile: 'resource-avatar-selection-v1', expectedSelection: null, asset: first.asset,
    crop: 'xywh=percent:0,0,100,100', actingSubject: owner.actor };
  await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [`media:avatar:${work.work}`]);
  const noGrant = await owner.send('PUT', `/v1/resources/${target}/avatar`, selection);
  expect(noGrant.status).toBe(403);
  await owner.grant(`media:avatar:${work.work}`, 'media.avatar');
  const invalidCrop = await owner.send('PUT', `/v1/resources/${target}/avatar`, { ...selection, crop: 'xywh=1,2' });
  expect(invalidCrop.status).toBe(400);
  const selectKey = `select-${randomUUID()}`;
  const selected = await owner.send('PUT', `/v1/resources/${target}/avatar`, selection, selectKey);
  expect(selected.status).toBe(201);
  const head = await selected.json() as { selection: string; predecessor: null };
  expect(head.predecessor).toBeNull();
  const replay = await owner.send('PUT', `/v1/resources/${target}/avatar`, selection, selectKey);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toMatchObject({ selection: head.selection, replayed: true });
  const stale = await owner.send('PUT', `/v1/resources/${target}/avatar`, selection);
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ code: 'stale_head', current: head.selection });
  const staleReceipts = await contentPool.query(`SELECT count(*)::int AS n FROM content.receipt
    WHERE action = 'media.selection.change' AND outcome = 'stale_head' AND reason = 'expected selection differs'
      AND operation_id IN (SELECT operation_id FROM content.outbox WHERE payload->>'target' = $1)`, [work.work]);
  expect(staleReceipts.rows[0].n).toBe(1);

  // The summary names the exact selection and delivers the exact bytes.
  const summary = await call('GET', `/v1/resources/${target}`);
  expect(summary.status).toBe(200);
  const body = await summary.json() as { avatar: { kind: string; url: string; selection: string } };
  expect(body.avatar).toMatchObject({ kind: 'image', selection: head.selection, mediaType: 'image/png',
    width: 256, height: 256, crop: 'xywh=percent:0,0,100,100' });
  const image = await call('GET', body.avatar.url);
  expect(image.status).toBe(200);
  expect(image.headers.get('etag')).toBe(`"${sha(bytes)}"`);
  expect(sha(new Uint8Array(await image.arrayBuffer()))).toBe(sha(bytes));

  // Asset disclosure CAS: a stale expected state is refused; the accepted change hides the image.
  const stateKey = `state-${randomUUID()}`;
  const stateBody = { profile: 'media-asset-state-v1', expectedState: randomUUID(), disclosure: 'private',
    lifecycle: 'active', actingSubject: owner.actor };
  const staleState = await owner.send('POST', `/v1/media/assets/${first.asset}/state`, stateBody, stateKey);
  expect(staleState.status).toBe(409);
  const hidden = await owner.send('POST', `/v1/media/assets/${first.asset}/state`,
    { ...stateBody, expectedState: first.stateHead });
  expect(hidden.status).toBe(201);
  const hiddenSummary = await (await call('GET', `/v1/resources/${target}`)).json() as { avatar: { kind: string } };
  expect(hiddenSummary.avatar.kind).toBe('fallback');
  expect((await call('GET', body.avatar.url)).status).toBe(404);
}, 120_000);
