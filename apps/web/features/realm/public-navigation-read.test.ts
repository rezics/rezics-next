import { expect, test } from 'bun:test';
import { direction } from '@rezics/main/language';
import { completePublicNavigation } from './public-navigation.ts';
import type { Loaded, ZonePresentationRead } from './types.ts';

const mounts = (first: number, count: number) => Array.from({ length: count }, (_, index) => ({
  occurrence: `mount-${first + index}`, segment: `entry-${first + index}`, target: `target-${first + index}`,
  kind: 'index' as const, name: { value: `Page ${first + index}`, language: 'en', direction: direction('en', `Page ${first + index}`) },
}));
function page(navigation: ReturnType<typeof mounts>, next: string | null,
  changed: Partial<ZonePresentationRead> = {}): Loaded<ZonePresentationRead> {
  return { ok: true, data: { zone: 'published-zone', revision: 'publication', navigationRevision: 'navigation',
    navigation, navigationNext: next, navigationComplete: next === null,
    home: { reference: { revisionId: 'published-home' } }, ...changed } as unknown as ZonePresentationRead };
}
function reader(pages: Loaded<ZonePresentationRead>[]) {
  const cursors: Array<string | undefined> = [];
  return { cursors, read: async (cursor?: string): Promise<Loaded<ZonePresentationRead>> => {
    cursors.push(cursor);
    const next = pages.shift();
    if (!next) throw new Error('Unexpected navigation continuation');
    return next;
  } };
}

test('the complete public frame selection appends the fifty-first mount in order', async () => {
  const first = page(mounts(1, 50), 'published-tail');
  const source = reader([first, page(mounts(51, 1), null)]);
  const result = await completePublicNavigation(source.read);
  expect(source.cursors).toEqual([undefined, 'published-tail']);
  if (!result.ok || !first.ok) throw new Error('Expected a complete public selection');
  expect(result.data.navigation.map(item => item.segment)).toEqual(mounts(1, 51).map(item => item.segment));
  expect(result.data.home).toBe(first.data.home);
  expect(result.data).toMatchObject({ navigationRevision: 'navigation', navigationNext: null, navigationComplete: true });
});

for (const changed of [{ revision: 'new-publication' }, { navigationRevision: 'new-navigation' }, { zone: 'other-zone' }]) {
  test(`a changed ${Object.keys(changed)[0]} refuses mixed public cuts`, async () => {
    const source = reader([page(mounts(1, 50), 'tail'), page(mounts(51, 1), null, changed)]);
    expect(await completePublicNavigation(source.read)).toEqual({ ok: false, failure: 'moved' });
  });
}

for (const failure of ['missing', 'moved', 'unavailable'] as const) {
  test(`a ${failure} continuation refuses the incomplete frame`, async () => {
    const source = reader([page(mounts(1, 50), 'tail'), { ok: false, failure, reference: 'read-reference' }]);
    expect(await completePublicNavigation(source.read)).toEqual({ ok: false, failure, reference: 'read-reference' });
  });
}

test('a cursor loop or repeated mount refuses traversal instead of duplicating links', async () => {
  const loop = reader([page(mounts(1, 50), 'tail'), page(mounts(51, 1), 'tail')]);
  expect(await completePublicNavigation(loop.read)).toEqual({ ok: false, failure: 'unavailable' });
  expect(loop.cursors).toHaveLength(2);
  const duplicate = reader([page(mounts(1, 50), 'tail'), page(mounts(50, 2), null)]);
  expect(await completePublicNavigation(duplicate.read)).toEqual({ ok: false, failure: 'unavailable' });
});

test('missing continuation and contradictory completeness never become a ready frame', async () => {
  const missing = reader([page(mounts(1, 50), null, { navigationComplete: false })]);
  expect(await completePublicNavigation(missing.read)).toEqual({ ok: false, failure: 'unavailable' });
  const contradictory = reader([page(mounts(1, 50), 'tail', { navigationComplete: true })]);
  expect(await completePublicNavigation(contradictory.read)).toEqual({ ok: false, failure: 'unavailable' });
});
