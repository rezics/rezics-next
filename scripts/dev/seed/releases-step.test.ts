import { expect, test } from 'bun:test';
import { releaseSeedPlan, seedReleaseIdentity, seedSerialWork } from './releases-step.ts';
import { SeedApiError, type SeedApi } from './api.ts';
import { seedKey } from './plan.ts';

test('the release seed records Hant and Hans print editions, an English translation, and two fixture snapshots', () => {
  const [hant, hans, english] = releaseSeedPlan.editions;
  expect(hant?.contentLanguages).toEqual(['zh-Hant']);
  expect(hans?.contentLanguages).toEqual(['zh-Hans']);
  expect(english).toMatchObject({ isTranslation: true, originalLanguages: ['zh'], contentLanguages: ['en'] });
  expect(releaseSeedPlan.serial.snapshots).toHaveLength(2);
  expect(releaseSeedPlan.serial.originalUrl).toBe('https://example.com/star-harbor');
  expect(JSON.stringify(releaseSeedPlan)).not.toContain('"mul"');
  expect(releaseSeedPlan.serial.snapshots.every(snapshot => snapshot.coverage.complete === false)).toBe(true);
});

test('G-909: editions keep their existing identity on the same Work and use stable identities on another Work', async () => {
  const legacy = releaseSeedPlan.editions[0].id;
  const oldWork = 'https://rezics.com/id/00000000-0000-4000-a000-000000000001';
  const importedWork = 'https://rezics.com/id/00000000-0000-4000-a000-000000000002';
  const api = { get: async (path: string, token: string) => {
    expect(path).toBe(`/v1/resources/${legacy.slice(-36)}?actingSubject=${encodeURIComponent(oldWork)}`);
    expect(token).toBe('author');
    return { type: 'release', work: oldWork };
  } } as unknown as SeedApi;
  expect(await seedReleaseIdentity(api, oldWork, legacy, 'author', oldWork)).toBe(legacy);
  const scoped = await seedReleaseIdentity(api, importedWork, legacy, 'author', oldWork);
  expect(scoped).toMatch(/^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(scoped).not.toBe(legacy);
  expect(await seedReleaseIdentity(api, importedWork, legacy, 'author', oldWork)).toBe(scoped);
});

test('G-909: missing or hidden release summaries do not mint replacement identities', async () => {
  const legacy = releaseSeedPlan.editions[0].id;
  const api = { get: async () => { throw new SeedApiError('release summary', 404, 'unavailable'); } } as unknown as SeedApi;
  expect(await seedReleaseIdentity(api, 'work', legacy, 'author', 'actor')).toBe(legacy);
  for (const status of [403, 503]) {
    const denied = { get: async () => { throw new SeedApiError('release summary', status, 'unavailable'); } } as unknown as SeedApi;
    await expect(seedReleaseIdentity(denied, 'work', legacy, 'author', 'actor')).rejects.toThrow(`HTTP ${status}`);
  }
});

test('G-909: a legacy serial creation is reused through its stable release owner without changing the POST key', async () => {
  const work = 'https://rezics.com/id/00000000-0000-4000-a000-000000000001';
  const reads: string[] = [];
  const calls: string[] = [];
  const header = { id: work, mainVersion: 'main', revision: 'work-head', mainVersionRevision: 'main-head',
    title: { value: releaseSeedPlan.serial.title as string, language: 'zh' }, types: ['https://schema.org/Book'] };
  const api = { post: async (_path: string, body: Record<string, unknown>, _token: string, key: string) => {
    calls.push(key);
    expect(body.authoring).toBe('own-work');
    throw new SeedApiError('Work creation', 409, '{"code":"idempotency_conflict"}');
  }, get: async (path: string) => {
    reads.push(path);
    return path.startsWith('/v1/resources/') ? { type: 'release', work } : header;
  } } as unknown as SeedApi;
  expect(await seedSerialWork(api, work, 'author')).toEqual({ work, mainVersion: 'main', workRevision: 'work-head',
    mainRevision: 'main-head', replayed: true });
  expect(calls).toEqual([seedKey('release-work', 'star-harbor')]);
  expect(reads.map(path => path.split('?')[0])).toEqual([
    `/v1/resources/${releaseSeedPlan.serial.release.slice(-36)}`, `/v1/works/${work.slice(-36)}`]);
  header.title.value = 'Another Work';
  await expect(seedSerialWork(api, work, 'author')).rejects.toThrow('idempotency_conflict');
  expect(calls).toEqual(Array(2).fill(seedKey('release-work', 'star-harbor')));
});

test('G-909: a fresh serial uses the creation receipt without discovery reads', async () => {
  const receipt = { work: 'work', mainVersion: 'main', workRevision: 'work-head', mainRevision: 'main-head', replayed: false };
  const api = { post: async () => receipt, get: async () => { throw new Error('unexpected read'); } } as unknown as SeedApi;
  expect(await seedSerialWork(api, 'actor', 'author')).toEqual(receipt);
});

test('G-909: unrelated serial creation failures retain their error and never trigger discovery', async () => {
  for (const [status, detail] of [[403, '{"code":"denied"}'], [409, '{"code":"another_conflict"}'], [409, 'unreadable response']] as const) {
    const error = new SeedApiError('Work creation', status, detail);
    const api = { post: async () => { throw error; }, get: async () => { throw new Error('unexpected read'); } } as unknown as SeedApi;
    await expect(seedSerialWork(api, 'actor', 'author')).rejects.toBe(error);
  }
});
