import { afterAll, expect, test } from 'bun:test';
import sharp from 'sharp';
import { sha, startMediaStack, type MediaStack } from './media-support.ts';

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

test('public showcase art is one shared, revalidating copy: 304 on its validator, no reader identity or introspection', async () => {
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

  // An Agent's read is decided by that reader's identity, so it stays private to them.
  const named = await expectStatus(await reader.read(url), 200);
  expect(named.headers.get('cache-control')).toBe('private, no-store');

  // Revalidation repeats every check: removed art is gone, not "not modified".
  await expectStatus(await owner.send('PUT', artPath, { ...body, expectedSelection: selected.selection,
    asset: null, crop: null }), 201);
  for (const headers of [{ 'if-none-match': etag }, { 'if-none-match': etag, authorization: `Bearer ${reader.token}` }]) {
    expect((await get(url, headers)).status).toBe(404);
  }
});

test('private media stays private and uncacheable, and a bearer alone still reaches none of it', async () => {
  const { main, member, privateWork } = await stack();
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
  expect(granted.headers.get('cache-control')).toBe('private, no-store');
  expect(sha(new Uint8Array(await granted.arrayBuffer()))).toBe(sha(bytes));
  for (const headers of [{}, { authorization: `Bearer ${reader.token}` }, { 'if-none-match': etag },
    { 'if-none-match': etag, authorization: `Bearer ${reader.token}` }]) {
    expect((await get(path, headers)).status).toBe(404);
  }
});
