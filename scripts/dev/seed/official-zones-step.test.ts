import { expect, test } from 'bun:test';
import { modReleaseBound, realmKeyed, type ModRead } from './official-zones-step.ts';

const work = 'https://rezics.com/id/00000000-0000-4000-a000-000000000001';
const realm = 'https://rezics.com/id/00000000-0000-4000-a000-000000000002';

test('a Realm planned with a handle names itself in its keys, since an earlier Realm holds the plain ones', () => {
  expect(realmKeyed('mods', realm)).toBe('mods:00000000-0000-4000-a000-000000000002');
});

test('a Realm planned without a handle keeps its plain keys', () => {
  expect(realmKeyed('fiction', realm)).toBe('fiction');
});

function releases(pages: { items: { version: string | null; gameVersions: string[]; mod: { ecosystem: string } | null }[]; nextCursor: string | null }[]) {
  const seen: string[] = [];
  const read: ModRead = async path => { seen.push(path); return pages[seen.length - 1] ?? null; };
  return { read, seen };
}
const bound = (version: string, gameVersions = ['1.21.1'], ecosystem = 'fabric') => ({ version, gameVersions, mod: { ecosystem } });

test('a release the Work already lists needs no binding, found on any page', async () => {
  const { read, seen } = releases([{ items: [bound('1.0.0')], nextCursor: 'next' }, { items: [bound('1.3.0')], nextCursor: null }]);
  expect(await modReleaseBound(read, work, '1.3.0', '1.21.1', 'fabric')).toBe(true);
  expect(seen).toEqual([`/v1/mod-releases/${work.slice(-36)}`, `/v1/mod-releases/${work.slice(-36)}?cursor=next`]);
});

test('a release that differs in version, game version or loader still needs its binding', async () => {
  const page = { items: [bound('1.3.0')], nextCursor: null };
  expect(await modReleaseBound(releases([page]).read, work, '1.3.1', '1.21.1', 'fabric')).toBe(false);
  expect(await modReleaseBound(releases([page]).read, work, '1.3.0', '1.20.1', 'fabric')).toBe(false);
  expect(await modReleaseBound(releases([page]).read, work, '1.3.0', '1.21.1', 'forge')).toBe(false);
  expect(await modReleaseBound(releases([]).read, work, '1.3.0', '1.21.1', 'fabric')).toBe(false);
});
