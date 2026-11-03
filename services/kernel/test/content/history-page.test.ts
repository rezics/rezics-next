import { afterAll, beforeAll, expect, setDefaultTimeout, spyOn, test } from 'bun:test';
import { documentText } from '@rezics/document';
import * as revisionPages from '../../src/content/revision-pages.ts';
import { SESSION_HEADER } from '../../src/http/request.ts';
import { createContentDisclosureDriver } from './disclosure-driver.ts';
import * as nativeSystem from './support/native-system.ts';

setDefaultTimeout(180_000);
let driver: Awaited<ReturnType<typeof createContentDisclosureDriver>>;
let system: nativeSystem.NativeContentSystem;
beforeAll(async () => {
  const create = nativeSystem.createNativeContentSystem;
  const observation = spyOn(nativeSystem, 'createNativeContentSystem').mockImplementation(async (...args) => {
    system = await create(...args);
    return system;
  });
  try {
    driver = await createContentDisclosureDriver();
  } finally {
    observation.mockRestore();
  }
});
afterAll(async () => driver?.close());

async function read(path: string, persona: 'anonymous' | 'author' | 'suspended' = 'anonymous') {
  const actor = persona === 'anonymous' ? null : system.actors[persona];
  return system.kernel.handle(
    new Request(`https://content.test${path}`, {
      headers: actor ? { authorization: `Bearer ${actor.bearer}` } : {},
    }),
  );
}
async function page(path: string) {
  const response = await read(path);
  expect(response.status).toBe(200);
  expect(response.headers.get(SESSION_HEADER)).toBeTruthy();
  return response.json();
}
async function fixture() {
  const board = await driver.board();
  const thread = await driver.publish({ board, body: 'Conversation opening' });
  const post = await driver.publish({ board, thread, body: 'First revision' });
  return { thread, post, path: `/v1/posts/${post.id}/revisions` };
}

test('mounted native history pages 20/21 exact revisions without changing the current post', async () => {
  const { post, path } = await fixture();
  const ids = [post.revision.id];
  for (let i = 1; i <= 20; i++) ids.push((await driver.edit(post, `Revision ${i}`)).id);
  const before = await driver.inspectCommandCopies(post);
  const first = await page(path);
  expect(first.revisions.map((value: { revisionId: string }) => value.revisionId)).toEqual(ids.slice(0, 20));
  const second = await page(`${path}?cursor=${encodeURIComponent(first.next)}`);
  expect(second.revisions.map((value: { revisionId: string }) => value.revisionId)).toEqual(ids.slice(20));
  expect(second.next).toBeNull();
  expect((await page(`${path}?limit=100`)).revisions).toHaveLength(21);
  expect((await page(`${path}?limit=1`)).revisions[0].revisionId).toBe(ids[0]);
  const exact = await driver.read('anonymous', post, ids[0]);
  expect(exact.response.status).toBe(200);
  expect(exact.value?.revision.body).toBe('First revision');
  expect((await driver.read('author', post)).value?.revision.id).toBe(ids.at(-1)!);
  expect(documentText(first.revisions[0].body)).toBe('First revision');
  expect((await read(path, 'author')).status).toBe(200);
  expect((await read(path, 'suspended')).status).toBe(401);
  expect((await read(`${path}?cursor=${encodeURIComponent(first.next)}`, 'author')).status).toBe(400);
  for (const limit of [0, 101]) expect((await read(`${path}?limit=${limit}`)).status).toBe(400);
  expect(await driver.inspectCommandCopies(post)).toEqual(before);
});

test('a changed source withholds all selected bodies and same-cursor retry retains exact keys', async () => {
  const { post, path } = await fixture();
  const secondId = (await driver.edit(post, 'Second revision')).id;
  const first = await page(`${path}?limit=1`);
  const nextPath = `${path}?limit=1&cursor=${encodeURIComponent(first.next)}`;
  const select = revisionPages.pageRevisionCandidates;
  const observation = spyOn(revisionPages, 'pageRevisionCandidates').mockImplementationOnce(async (...args) => {
    const selected = await select(...args);
    await driver.edit(post, 'Changed during selection');
    return selected;
  });
  try {
    const response = await read(nextPath);
    expect(response.status).toBe(404);
    expect(response.headers.get(SESSION_HEADER)).toBeNull();
    expect(await response.text()).not.toContain('Second revision');
  } finally {
    observation.mockRestore();
  }
  const retry = await page(nextPath);
  expect(retry.revisions[0].revisionId).toBe(secondId);
  expect(documentText(retry.revisions[0].body)).toBe('Second revision');
});

test('current takedown during hydration withholds the page, including an empty selection', async () => {
  const { post, path } = await fixture();
  const select = revisionPages.pageRevisionCandidates;
  const observation = spyOn(revisionPages, 'pageRevisionCandidates').mockImplementationOnce(async (...args) => {
    await select(...args);
    const removed = await driver.takedown('moderator', post, crypto.randomUUID());
    expect(removed.response.status).toBe(200);
    return { candidates: [], nextKey: null };
  });
  try {
    const response = await read(path);
    expect(response.status).toBe(404);
    expect(response.headers.get(SESSION_HEADER)).toBeNull();
  } finally {
    observation.mockRestore();
  }
});
