import { expect, test } from 'bun:test';
import { createSharedSummaryCoverFixture } from './support/shared-summary-cover-fixture.ts';

const surfaces = ['shared', 'subject', 'related', 'graph', 'links'] as const;

test('a current exact cover fence withholds shared and HTTP summaries even while projection consumers pause', async () => {
  const f = await createSharedSummaryCoverFixture();
  try {
    const { primary, independent } = await f.seedPair();
    const before = new Map<string, Awaited<ReturnType<typeof f.observe>>>();
    for (const surface of surfaces) {
      const seen = await f.observe(surface, primary.id);
      expect(seen.httpStatus).toBe(surface === 'shared' ? null : 200);
      expect(seen.value).not.toBeNull();
      expect(seen.value!.cover).toHaveProperty('media', primary.media);
      before.set(surface, structuredClone(seen));
    }
    const other = await f.observe('shared', independent.id);
    expect(other.value!.cover).toHaveProperty('media', independent.media);
    await f.pauseProjection();
    expect((await f.takeDown(primary, 'cover')).status).toBe(200);
    for (const surface of surfaces) {
      const after = await f.observe(surface, primary.id);
      expect(after.httpStatus).toBe(before.get(surface)!.httpStatus);
      expect(after.value).not.toBeNull();
      expect(after.value!.cover).toBeNull();
      const { cover: ignoredBefore, ...prior } = before.get(surface)!.value!;
      const { cover: ignoredAfter, ...current } = after.value!;
      expect(current).toEqual(prior);
    }
    expect((await f.observe('shared', independent.id)).value).toEqual(other.value);
  } finally {
    await f.close();
  }
}, 180_000);

test('a summary-source fence does not hide an independently licensed selected cover', async () => {
  const f = await createSharedSummaryCoverFixture();
  try {
    const { primary } = await f.seedPair();
    const before = await f.observe('shared', primary.id);
    expect(before.value!.cover).toHaveProperty('media', primary.media);
    expect((await f.takeDown(primary, 'summary')).status).toBe(200);
    expect((await f.observe('shared', primary.id)).value).toEqual(before.value);
  } finally {
    await f.close();
  }
}, 180_000);

test('missing trusted routing configuration rejects before native summary I/O', async () => {
  const f = await createSharedSummaryCoverFixture();
  try {
    const { primary } = await f.seedPair();
    const before = f.nativeQueryCount();
    await expect(f.readWithoutRoutingKey(primary.id)).rejects.toBeInstanceOf(TypeError);
    expect(f.nativeQueryCount()).toBe(before);
  } finally {
    await f.close();
  }
}, 180_000);
