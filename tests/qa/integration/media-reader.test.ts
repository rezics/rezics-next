import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { png, sha, startMediaStack, type MediaStack } from './media-support.ts';

let started: Promise<MediaStack> | undefined;
const stack = () => started ??= startMediaStack('media-reader');
afterAll(async () => { if (started) await (await started).stop(); });

const ID = 'https://rezics.com/id/';

test('signed-in public media readers need no Agent, and gain no private Work authority', async () => {
  const { member, publicWork, privateWork, call } = await stack();
  const owner = await member('image-owner');
  const reader = await member('image-reader');
  const visible = await publicWork(owner.actor);
  const hidden = await privateWork(owner.actor, `Private image ${randomUUID()}`);
  const bytes = png(256, 256);
  const asset = await owner.upload(bytes, 'public');
  const hiddenAsset = await owner.upload(png(256,256), 'public');
  const select = async (work: string, image = asset.asset) => {
    await owner.grant(`media:avatar:${work}`, 'media.avatar');
    const response = await owner.send('PUT', `/v1/resources/${work.slice(ID.length)}/avatar`, {
      profile: 'resource-avatar-selection-v1', expectedSelection: null, asset: image,
      crop: null, actingSubject: owner.actor,
    });
    expect(response.status).toBe(201);
    return (await response.json()).selection as string;
  };
  const visibleAvatar = await select(visible.work);
  await owner.grant(`work:read:${hidden.work}`, 'work.read');
  const hiddenAvatar = await select(hidden.work, hiddenAsset.asset);
  const prepare = async (work: string, image = asset.asset) => {
    await owner.grant(`content:draft:${work}`, 'content.draft');
    const response = await owner.send('POST', '/v1/media/publications', {
      profile: 'media-set-v1', resourceId: work, variantId: `urn:rezics:variant:${randomUUID()}`,
      expectedHead: null, assets: [image], actingSubject: owner.actor,
    });
    expect(response.status).toBe(201);
    return (await response.json()).body.items[0] as { use: string; representation: string };
  };
  const visibleItem = await prepare(visible.work);
  const hiddenItem = await prepare(hidden.work, hiddenAsset.asset);
  const paths = (avatar: string, item: typeof visibleItem) => [
    `/v1/media/avatars/${avatar}`, `/v1/media/uses/${item.use}`,
    `/v1/media/representations/${item.representation}/bytes?use=${item.use}`,
  ];
  for (const path of paths(visibleAvatar, visibleItem)) {
    for (const token of [undefined, reader.token]) {
      const response = await call('GET', path, { token });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('image/png');
      expect(sha(new Uint8Array(await response.arrayBuffer()))).toBe(sha(bytes));
    }
  }
  const metadata = async (item: typeof visibleItem, actingSubject?: string) => {
    const response = await call('POST', '/v1/media/metadata', { token: reader.token,
      body: { items: [{ representation: item.representation, use: item.use }], ...(actingSubject ? { actingSubject } : {}) } });
    expect(response.status).toBe(200);
    return (await response.json()).items[0];
  };
  expect(await metadata(visibleItem)).toMatchObject({ status: 'available' });
  for (const path of paths(hiddenAvatar, hiddenItem)) {
    expect((await call('GET', path, { token: reader.token })).status).toBe(404);
  }
  expect(await metadata(hiddenItem)).toMatchObject({ status: 'unavailable' });
  const summaries = await call('POST', '/v1/resources/summaries', { token: reader.token,
    body: { profile: 'resource-summary-batch-v1', resources: [visible.work, hidden.work] } });
  expect(summaries.status).toBe(200);
  expect((await summaries.json()).summaries.map((item: { status: string }) => item.status)).toEqual(['available', 'unavailable']);
  const showcase = await call('POST', '/v1/resources/showcase', { token: reader.token,
    body: { profile: 'work-showcase-batch-v1', targets: [visible.work, hidden.work] } });
  expect(showcase.status).toBe(200);
  expect((await showcase.json()).items.map((item: { status: string }) => item.status)).toEqual(['available', 'unavailable']);
  await reader.grant(`work:read:${hidden.work}`, 'work.read');
  expect((await reader.read(`/v1/media/avatars/${hiddenAvatar}`)).status).toBe(200);
  expect(await metadata(hiddenItem, reader.actor)).toMatchObject({ status: 'available' });
  // A read grant still needs its explicit Agent; a bearer alone never starts using it.
  expect((await call('GET', `/v1/media/uses/${hiddenItem.use}`, { token: reader.token })).status).toBe(404);
});
