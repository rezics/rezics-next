import { afterAll, beforeAll, expect, test } from 'bun:test';
import { definition, membersPreparationRuntime } from './support/members-preparation-runtime.ts';

let native: Awaited<ReturnType<typeof membersPreparationRuntime>>;

beforeAll(async () => {
  native = await membersPreparationRuntime();
}, 120000);

afterAll(async () => {
  await native?.close();
});

test('a mounted private Collection can reserve, touch and admit its exact native episode', async () => {
  const fixture = await native.fixture();
  const reserved = await fixture.store.reserve(fixture.actor, fixture.collectionId, [definition()]);
  expect(reserved.episodes).toHaveLength(1);
  const [episode] = reserved.episodes;
  expect(episode).toMatchObject({ state: 'preparing', locator: { collectionId: fixture.collectionId } });
  expect(reserved.intent?.input.episodes).toEqual([
    { collectionId: fixture.collectionId, episodeId: episode!.locator.episodeId },
  ]);
  expect((await native.workflow(episode!.workflowId)).status?.status).toBe('ENQUEUED');
  expect(await fixture.store.touch(fixture.actor, episode!.locator)).toBe(true);
  expect(await native.step(episode!.locator)).toBe(true);
});
