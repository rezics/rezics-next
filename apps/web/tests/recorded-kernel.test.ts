import { afterEach, expect, test } from 'bun:test';
import { createStoryRecordedKernelFetch, storyViewerId } from '../src/kernel/fake';
import { storyViewerId as canonicalViewerId } from '../src/kernel/fake/identities';
import { setHoldingsLogStory } from '../src/kernel/fake/library-holdings-history';
import recording from '../src/kernel/recorded/library-published-log.json';

const recorded = createStoryRecordedKernelFetch();
const path = `https://kernel.test/v1/publishedLogs/${recording.publishedLog.id}`;
const historyLog = { ...recording.publishedLog, accountId: canonicalViewerId };

afterEach(() => setHoldingsLogStory(false));

test('the shared recorded world and opt-in history initialize with the same canonical viewer', async () => {
  expect(storyViewerId).toBe(canonicalViewerId);
  const baseline = await recorded(path);
  const baselineBody = await baseline.json();
  expect(baselineBody.publishedLog).toMatchObject({
    accountId: storyViewerId,
    account: { id: storyViewerId },
  });
  expect(baseline.headers.get('Library-Published-Log-Revision')).toBeNull();

  setHoldingsLogStory(true);
  const enabled = await recorded(path);
  expect(enabled.status).toBe(200);
  expect(enabled.headers.get('Library-Published-Log-Revision')).toBe('1');
  expect(await enabled.json()).toEqual({ publishedLog: historyLog });

  setHoldingsLogStory(false);
  expect(await (await recorded(path)).json()).toEqual(baselineBody);
});

test('opt-in history retains deletion, restore guards, refusal and reset through the shared transport', async () => {
  setHoldingsLogStory(true);
  const remove = (revision: number) => recorded(`${path}?revision=${revision}`, { method: 'DELETE' });
  const restore = (body: unknown) => recorded(`${path}:restore`, { method: 'POST', body: JSON.stringify(body) });
  const stale = await remove(0);
  expect(stale.status).toBe(409);
  expect(await stale.json()).toEqual({ code: 'conflict' });

  const removed = await remove(1);
  expect(removed.status).toBe(200);
  expect(await removed.json()).toEqual({ publishedLog: historyLog });
  const deletionId = removed.headers.get('Library-Published-Log-Deletion-Id');
  expect(deletionId).toBe('0192f3a0-6c1e-7b2a-9d4e-000000000050');
  expect(removed.headers.get('Library-Published-Log-Deletion-Revision')).toBe('2');
  expect(await (await recorded(path)).json()).toEqual({
    publishedLog: { id: historyLog.id, deleted: true },
  });
  expect((await remove(2)).status).toBe(409);
  for (const body of [null, {}, { deletionId: 'stale', revision: 2 }, { deletionId, revision: 1 }]) {
    const refused = await restore(body);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ code: 'published_log_restore_stale' });
  }
  const restored = await restore({ deletionId, revision: 2 });
  expect(restored.status).toBe(200);
  expect(restored.headers.get('Library-Published-Log-Revision')).toBe('3');
  expect(await restored.json()).toEqual({ publishedLog: historyLog });
  expect((await restore({ deletionId, revision: 2 })).status).toBe(409);

  setHoldingsLogStory(true, true);
  await remove(1);
  const expired = await restore({ deletionId, revision: 2 });
  expect(expired.status).toBe(409);
  expect(await expired.json()).toEqual({ code: 'published_log_restore_expired' });

  setHoldingsLogStory(true);
  expect((await recorded(path)).headers.get('Library-Published-Log-Revision')).toBe('1');
  await remove(1);
  expect((await restore({ deletionId, revision: 2 })).status).toBe(200);
});
