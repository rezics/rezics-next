import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { png, sha, startMediaStack, type MediaStack } from './media-support.ts';

let started: Promise<MediaStack> | undefined;
const stack = () => started ??= startMediaStack('media-delivery-cache');
afterAll(async () => { if (started) await (await started).stop(); });

const ID = 'https://rezics.com/id/';
const landscape = () => sharp({ create: { width: 1280, height: 720, channels: 4,
  background: { r: 20, g: 40, b: 60, alpha: 0.5 } } }).png().toBuffer();

async function expectStatus(response: Response, expected: number) {
  if (response.status !== expected) throw new Error(`expected ${expected}, got ${response.status}: ${await response.text()}`);
  return response;
}

test('public showcase art shares cache headers and validators for anonymous, bearer and acting-Agent readers', async () => {
  const { main, call, member, publicWork } = await stack();
  const get = (path: string, headers: Record<string, string> = {}) =>
    main.handle(new Request(`http://main.local${path}`, { headers }));
  const owner = await member('art-owner');
  const reader = await member('art-reader');
  const work = await publicWork(owner.actor);
  const bytes = new Uint8Array(await landscape());
  const asset = await owner.upload(bytes);
  await owner.grant(`media:avatar:${work.work}`, 'media.avatar');
  const artPath = `/v1/resources/${work.work.slice(ID.length)}/showcase/art`;
  const body = { profile: 'work-showcase-selection-v1', expectedSelection: null, asset: asset.asset,
    role: 'background-landscape', crop: 'xywh=percent:0,0,100,100', actingSubject: owner.actor };
  const selected = await (await expectStatus(await owner.send('PUT', artPath, body), 201)).json() as { selection: string };
  const batch = await (await expectStatus(await call('POST', '/v1/resources/showcase', {
    body: { profile: 'work-showcase-batch-v1', targets: [work.work] } }), 200)).json();
  const url = batch.items[0].images[0].url as string;
  expect(url).toBe(`/v1/media/representations/${asset.representation}/bytes?use=${batch.items[0].images[0].use}`);
  const etag = `"${sha(bytes)}"`;

  // A reader's bearer adds nothing to public art. The QA Account refuses an unknown bearer,
  // so its success shows public art is decided without introspecting the reader.
  for (const headers of [{}, { authorization: `Bearer ${reader.token}` }, { authorization: 'Bearer unknown-to-account' }]) {
    const response = await expectStatus(await get(url, headers), 200);
    expect(response.headers.get('cache-control')).toBe('public, no-cache');
    expect(response.headers.get('etag')).toBe(etag);
    expect(sha(new Uint8Array(await response.arrayBuffer()))).toBe(sha(bytes));
  }
  for (const validator of [etag, `"other", W/${etag}`, '*']) {
    for (const headers of [{ 'if-none-match': validator }, { 'if-none-match': validator, authorization: `Bearer ${reader.token}` }]) {
      const response = await expectStatus(await get(url, headers), 304);
      expect(response.headers.get('etag')).toBe(etag);
      expect(response.headers.get('cache-control')).toBe('public, no-cache');
      expect((await response.arrayBuffer()).byteLength).toBe(0);
    }
  }
  expect((await expectStatus(await get(url, { 'if-none-match': '"other"' }), 200)).headers.get('etag')).toBe(etag);

  // Naming an Agent does not change public bytes or their cache policy.
  const namedPath = `${url}&actingSubject=${encodeURIComponent(reader.actor)}`;
  for (const validator of [undefined, etag, `"other", W/${etag}`, '*']) {
    const response = await expectStatus(await get(namedPath, {
      authorization: `Bearer ${reader.token}`, ...(validator ? { 'if-none-match': validator } : {}),
    }), validator ? 304 : 200);
    expect(response.headers.get('cache-control')).toBe('public, no-cache');
    expect(response.headers.get('etag')).toBe(etag);
    if (validator) expect((await response.arrayBuffer()).byteLength).toBe(0);
    else expect(sha(new Uint8Array(await response.arrayBuffer()))).toBe(sha(bytes));
  }

  // Revalidation repeats every check: removed art is gone, not "not modified".
  await expectStatus(await owner.send('PUT', artPath, { ...body, expectedSelection: selected.selection,
    asset: null, crop: null }), 201);
  for (const headers of [{ 'if-none-match': etag }, { 'if-none-match': etag, authorization: `Bearer ${reader.token}` }]) {
    expect((await get(url, headers)).status).toBe(404);
  }
  expect((await get(namedPath, { 'if-none-match': etag, authorization: `Bearer ${reader.token}` })).status).toBe(404);
});

test('public publication-item delivery shares cache headers and validators with signed-in readers', async () => {
  const { main, member, publicWork } = await stack();
  const owner = await member('publication-owner');
  const reader = await member('publication-reader');
  const work = await publicWork(owner.actor);
  const bytes = png(320, 200);
  const asset = await owner.upload(bytes);
  await owner.grant(`content:draft:${work.work}`, 'content.draft');
  const saved = await (await expectStatus(await owner.send('POST', '/v1/media/publications', {
    profile: 'media-set-v1', resourceId: work.work, variantId: `urn:rezics:variant:${randomUUID()}`,
    expectedHead: null, assets: [asset.asset], actingSubject: owner.actor,
  }), 201)).json();
  const path = `/v1/media/uses/${saved.body.items[0].use}`;
  const etag = `"${sha(bytes)}"`;
  for (const actor of [undefined, reader.actor]) {
    const url = new URL(`http://main.local${path}`);
    if (actor) url.searchParams.set('actingSubject', actor);
    for (const token of [undefined, reader.token]) {
      for (const validator of [undefined, etag]) {
        const response = await expectStatus(await main.handle(new Request(url, { headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(validator ? { 'if-none-match': validator } : {}),
        } })), validator ? 304 : 200);
        expect(response.headers.get('cache-control')).toBe('public, no-cache');
        expect(response.headers.get('etag')).toBe(etag);
        if (validator) expect((await response.arrayBuffer()).byteLength).toBe(0);
        else expect(sha(new Uint8Array(await response.arrayBuffer()))).toBe(sha(bytes));
      }
    }
  }
});

test('draft-target media revalidates only in private caches; revoked, anonymous and bearer-only readers receive no bytes or 304', async () => {
  const { main, member, privateWork, accessPool } = await stack();
  const get = (path: string, headers: Record<string, string> = {}) =>
    main.handle(new Request(`http://main.local${path}`, { headers }));
  const owner = await member('private-owner');
  const reader = await member('private-reader');
  const hidden = await privateWork(owner.actor);
  const bytes = new Uint8Array(await landscape());
  const asset = await owner.upload(bytes);
  await owner.grant(`work:read:${hidden.work}`, 'work.read');
  await owner.grant(`media:avatar:${hidden.work}`, 'media.avatar');
  const avatar = await (await expectStatus(await owner.send('PUT', `/v1/resources/${hidden.work.slice(ID.length)}/avatar`, {
    profile: 'resource-avatar-selection-v1', expectedSelection: null, asset: asset.asset,
    crop: null, actingSubject: owner.actor }), 201)).json() as { selection: string };
  const path = `/v1/media/avatars/${avatar.selection}`;
  await reader.grant(`work:read:${hidden.work}`, 'work.read');
  const etag = `"${sha(bytes)}"`;
  const granted = await expectStatus(await reader.read(path), 200);
  expect(granted.headers.get('cache-control')).toBe('private, no-cache');
  expect(sha(new Uint8Array(await granted.arrayBuffer()))).toBe(sha(bytes));
  const namedPath = `${path}?actingSubject=${encodeURIComponent(reader.actor)}`;
  const namedHeaders = { 'if-none-match': etag, authorization: `Bearer ${reader.token}` };
  const revalidated = await expectStatus(await get(namedPath, namedHeaders), 304);
  expect(revalidated.headers.get('cache-control')).toBe('private, no-cache');
  expect(revalidated.headers.get('etag')).toBe(etag);
  expect((await revalidated.arrayBuffer()).byteLength).toBe(0);
  for (const headers of [{}, { authorization: `Bearer ${reader.token}` }, { 'if-none-match': etag },
    { 'if-none-match': etag, authorization: `Bearer ${reader.token}` }]) {
    expect((await get(path, headers)).status).toBe(404);
  }
  await accessPool.query(`UPDATE access.permission_grant SET active = false, generation = generation + 1
    WHERE recipient_subject = $1 AND scope_id = $2 AND action = 'work.read'`, [reader.actor, `work:read:${hidden.work}`]);
  expect((await get(namedPath, namedHeaders)).status).toBe(404);
});
