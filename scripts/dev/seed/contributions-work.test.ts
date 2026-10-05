import { expect, test } from 'bun:test';
import { SeedApiError, type SeedApi } from './api.ts';
import { onEarlierWork, replayEarlierWork } from './contributions-work.ts';
import type { WorkReceipt } from './state.ts';

const receipt = (suffix: string, replayed = true) => ({ work: `https://rezics.com/id/${suffix}`, mainVersion: `https://rezics.com/id/${suffix}-v`,
  workRevision: 'r', mainRevision: 'm', replayed }) satisfies WorkReceipt;
const now = receipt('00000000-0000-4000-a000-00000000000b');
const earlier = receipt('00000000-0000-4000-a000-00000000000a');
const conflict = () => new SeedApiError('Main /v1/contributions', 409, '{"code":"idempotency_conflict"}');

function api(answer: (body: Record<string, unknown>) => WorkReceipt | Error) {
  const sent: Record<string, unknown>[] = [];
  const fake = { post: async (_path: string, body: Record<string, unknown>) => {
    sent.push(body);
    const result = answer(body);
    if (result instanceof Error) throw result;
    return result;
  } } as unknown as SeedApi;
  return { fake, sent };
}

test('a write that does not conflict stays on the plan Work and looks for no earlier one', async () => {
  let looked = false;
  const outcome = await onEarlierWork(now, async () => { looked = true; return earlier; }, async work => work.work);
  expect(outcome).toEqual({ work: now, result: now.work });
  expect(looked).toBe(false);
});

test('a conflicting key moves the write to the earlier Work that holds it', async () => {
  const outcome = await onEarlierWork(now, async () => earlier, async work => {
    if (work.work === now.work) throw conflict();
    return 'replayed';
  });
  expect(outcome).toEqual({ work: earlier, result: 'replayed' });
});

test('a conflict with no earlier Work, or the same Work, stays a finding', async () => {
  const refused = conflict();
  await expect(onEarlierWork(now, async () => null, async () => { throw refused; })).rejects.toBe(refused);
  await expect(onEarlierWork(now, async () => now, async () => { throw refused; })).rejects.toBe(refused);
});

test('other refusals do not look for an earlier Work', async () => {
  const stale = new SeedApiError('Main /v1/contributions', 409, '{"code":"stale_head"}');
  let looked = false;
  await expect(onEarlierWork(now, async () => { looked = true; return earlier; }, async () => { throw stale; })).rejects.toBe(stale);
  expect(looked).toBe(false);
});

test('the author\'s creation key replays the earlier Work', async () => {
  const { fake, sent } = api(() => earlier);
  expect(await replayEarlierWork(fake, [{ title: 'a' }, { title: 'b' }], 'token', 'key')).toBe(earlier);
  expect(sent).toEqual([{ title: 'a' }]);
});

test('an older recorded intent is tried when the newest conflicts', async () => {
  const { fake, sent } = api(body => body.language === 'en' ? earlier : conflict());
  expect(await replayEarlierWork(fake, [{ language: 'zh' }, { language: 'en' }], 'token', 'key')).toBe(earlier);
  expect(sent).toHaveLength(2);
});

test('a Work the author would create anew is not an earlier Work', async () => {
  expect(await replayEarlierWork(api(() => receipt('00000000-0000-4000-a000-00000000000c', false)).fake, [{}], 'token', 'key')).toBeNull();
});

test('a denied author has no earlier Work, and a transport failure is not hidden', async () => {
  const denied = new SeedApiError('Main /v1/works', 403, '{"code":"forbidden"}');
  expect(await replayEarlierWork(api(() => denied).fake, [{}], 'token', 'key')).toBeNull();
  await expect(replayEarlierWork(api(() => new Error('offline')).fake, [{}], 'token', 'key')).rejects.toThrow('offline');
});
