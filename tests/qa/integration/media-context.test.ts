import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { png, sha, startMediaStack, type MediaStack } from './media-support.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../../../services/main/src/modules/media/contract.ts';

let started: Promise<MediaStack> | undefined;
const stack = () => started ??= startMediaStack('media-context');
afterAll(async () => { if (started) await (await started).stop(); });

test('media accepts the platform global context for an independent document image use', async () => {
  const s = await stack();
  const owner = await s.member('media-context-author');
  const work = await s.publicWork(owner.actor);
  await owner.grant(`content:publish:${work.work}`, 'media.use');
  const image = await owner.upload(png(48, 48));
  const response = await owner.send('POST', '/v1/media/uses', {
    actingSubject: owner.actor, target: work.work, representation: image.representation,
    occurrence: randomUUID(), context: 'urn:rezics:context:global', conceal: false,
  });
  const answer = await response.text();
  console.info('Media global context owner answer', JSON.stringify({ status: response.status, answer }));
  expect(response.status, answer).toBe(201);
}, 180_000);

test('media context inputs share default selection, retry identity and storage without renaming answers', async () => {
  const s = await stack();
  const owner = await s.member('media-context-selection-author');
  const work = await s.publicWork(owner.actor);
  await owner.grant(`content:publish:${work.work}`, 'media.use');
  await owner.grant(`media:avatar:${work.work}`, 'media.avatar');
  await owner.grant(`work:read:${work.work}`, 'work.read');
  const bytes = new Uint8Array(await sharp({ create: { width: 1280, height: 720, channels: 4,
    background: { r: 20, g: 40, b: 60, alpha: 1 } } }).png().toBuffer());
  const image = await owner.upload(bytes);
  const resource = `/v1/resources/${work.work.split('/').at(-1)}`;
  const native = `https://rezics.com/id/${randomUUID()}`;
  const global = 'urn:rezics:context:global';
  const writes = [
    { name: 'document use', method: 'POST', path: '/v1/media/uses', body: {
      actingSubject: owner.actor, target: work.work, representation: image.representation,
      occurrence: randomUUID(), conceal: false,
    } },
    { name: 'avatar', method: 'PUT', path: `${resource}/avatar`, body: {
      profile: 'resource-avatar-selection-v1', actingSubject: owner.actor,
      expectedSelection: null, asset: image.asset, crop: null,
    } },
    { name: 'showcase art', method: 'PUT', path: `${resource}/showcase/art`, body: {
      profile: 'work-showcase-selection-v1', actingSubject: owner.actor,
      expectedSelection: null, asset: image.asset, role: 'background-landscape',
      crop: 'xywh=percent:0,0,100,100',
    } },
    { name: 'showcase trailer', method: 'PUT', path: `${resource}/showcase/trailer`, body: {
      profile: 'work-showcase-trailer-v1', actingSubject: owner.actor,
      expectedSelection: null, url: 'https://example.test/trailer',
    } },
  ];
  for (const write of writes) {
    const key = randomUUID();
    const created = await owner.send(write.method, write.path, { ...write.body, context: global }, key);
    const answer = await created.json();
    expect(created.status, `${write.name}: ${JSON.stringify(answer)}`).toBe(201);
    const retried = await owner.send(write.method, write.path, { ...write.body, context: DEFAULT_MEDIA_CONTEXT }, key);
    expect(retried.status, write.name).toBe(200);
    const replay = await retried.json();
    expect(replay).toEqual({ ...answer, replayed: true });
    const stored = write.name === 'document use'
      ? await s.contentPool.query('SELECT context FROM media.use WHERE id = $1', [answer.use])
      : await s.contentPool.query('SELECT context FROM media.selection_revision WHERE id = $1', [answer.selection]);
    expect(stored.rows).toEqual([{ context: DEFAULT_MEDIA_CONTEXT }]);
    const nativeBody = { ...write.body, context: native,
      ...(write.name === 'document use' ? { occurrence: randomUUID() } : {}) };
    const nativeResponse = await owner.send(write.method, write.path, nativeBody);
    const nativeAnswer = await nativeResponse.json();
    expect(nativeResponse.status, `${write.name}: ${JSON.stringify(nativeAnswer)}`).toBe(201);
    const nativeStored = write.name === 'document use'
      ? await s.contentPool.query('SELECT context FROM media.use WHERE id = $1', [nativeAnswer.use])
      : await s.contentPool.query('SELECT context FROM media.selection_revision WHERE id = $1', [nativeAnswer.selection]);
    expect(nativeStored.rows).toEqual([{ context: native }]);
    const refused = await owner.send(write.method, write.path, { ...write.body, context: 'urn:invalid:context' });
    expect(refused.status, write.name).toBe(400);
    console.info('Media context input covered', JSON.stringify({ surface: write.name,
      global: created.status, legacyReplay: retried.status, native: nativeResponse.status, invalid: refused.status }));
  }

  const reads = [
    { name: 'resource', read: (context: string) => owner.read(`${resource}?${new URLSearchParams({ context })}`) },
    { name: 'resource summaries', read: (context: string) => owner.send('POST', '/v1/resources/summaries', {
      profile: 'resource-summary-batch-v1', resources: [work.work], context,
    }) },
    { name: 'showcase batch', read: (context: string) => owner.send('POST', '/v1/resources/showcase', {
      profile: 'work-showcase-batch-v1', targets: [work.work], context,
    }) },
  ];
  for (const read of reads) {
    const globalResponse = await read.read(global);
    const legacyResponse = await read.read(DEFAULT_MEDIA_CONTEXT);
    const globalAnswer = await globalResponse.json();
    const legacyAnswer = await legacyResponse.json();
    expect(globalResponse.status, `${read.name}: ${JSON.stringify(globalAnswer)}`).toBe(200);
    expect(legacyResponse.status).toBe(200);
    expect(globalAnswer).toEqual(legacyAnswer);
    expect(JSON.stringify(globalAnswer)).not.toContain(global);
    if (read.name === 'showcase batch') {
      expect(globalAnswer.items[0].images[0].context).toBe(DEFAULT_MEDIA_CONTEXT);
      expect(globalAnswer.items[0].trailer.context).toBe(DEFAULT_MEDIA_CONTEXT);
    }
    const nativeResponse = await read.read(native);
    // A syntactically native ID is accepted even when no readable Context exists.
    expect([200, 404], read.name).toContain(nativeResponse.status);
    expect((await read.read('urn:invalid:context')).status, read.name).toBe(400);
    console.info('Media context input covered', JSON.stringify({ surface: read.name,
      global: globalResponse.status, legacy: legacyResponse.status, native: nativeResponse.status, invalid: 400 }));
  }

  const download = (context: string) => owner.read(`/v1/media/assets/${image.asset}/bytes?${new URLSearchParams({
    target: work.work, context,
  })}`);
  for (const context of [global, DEFAULT_MEDIA_CONTEXT, native]) {
    const response = await download(context);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get('etag')).toBe(`"${sha(bytes)}"`);
    expect(sha(new Uint8Array(await response.arrayBuffer()))).toBe(sha(bytes));
  }
  expect((await download('urn:invalid:context')).status).toBe(400);
  console.info('Media context input covered', JSON.stringify({ surface: 'asset download',
    global: 200, legacy: 200, native: 200, invalid: 400 }));
}, 240_000);
