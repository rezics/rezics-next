import { afterEach, describe, expect, test } from 'bun:test';
import { uuidToSid, type CanonicalAddress } from '@rezics/model/address';
import { readAddress, resolvedAddress, type ResolvedAddress } from '../features/address/client.ts';
import { canonicalHref, resourceHref, spaceHref } from '../features/address/path.ts';
import { decideAddress } from '../features/address/redirect.ts';
import type { AvailableSummary } from '../features/work-levels/types.ts';
import { workRefFromAddress } from '../features/work-page/read.ts';

const uuid = '0199a0fe-0b21-7000-8000-123456789abc';
const holder = `https://rezics.com/id/${uuid}`;
const survivor = 'https://rezics.com/id/0199a0fe-0b21-7000-8000-123456789abd';
const canonical = { prefix: '/w/' as const, key: '春の物語', slugSource: '春の物語' };
const summary = {
  reference: survivor,
  status: 'available',
  address: canonical,
} satisfies Pick<AvailableSummary, 'reference' | 'status' | 'address'>;
const merged: ResolvedAddress = {
  profile: 'address-resolution-v1',
  scope: 'work',
  key: 'old-story',
  status: 'resolved',
  holder,
  state: 'redirect',
  canonical,
  revision: uuid,
  resolution: { state: 'merged', source: holder, survivor, hops: 2 },
};
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('G-960 merged address contract', () => {
  test('resolution retains registry revision, merged identity and the summary canonical address', async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      expect(url.pathname).toBe('/v1/addresses/resolve');
      expect(Object.fromEntries(url.searchParams)).toEqual({ scope: 'work', key: 'old-story' });
      const headers = new Headers(init?.headers);
      expect(headers.has('authorization')).toBe(false);
      expect(headers.has('cookie')).toBe(false);
      expect(headers.get('accept-language')).toBe('ja,sv');
      expect(headers.get('x-rezics-display-languages')).toBe('ja,sv');
      return Response.json(merged);
    }) as typeof fetch;
    const read = await readAddress(
      { scope: 'work', key: 'old-story' },
      'ja,sv',
      'https://main.test',
    );
    expect(read).toEqual({ kind: 'resolved', data: merged });
    if (read.kind !== 'resolved') throw new Error('Expected a resolved address');
    expect(read.data.canonical).toEqual(summary.address);
    expect(resourceHref('/w/', canonical)).toBe(`${canonical.prefix}${encodeURIComponent(canonical.key)}`);
    expect(canonicalHref(read.data.canonical, 'ja')).toBe(`/ja${resourceHref('/w/', canonical)}`);
  });

  test('renamed and merged Works use the final canonical name instead of an intermediate UUID', async () => {
    expect(workRefFromAddress(merged)).toEqual({ kind: 'moved', slug: canonical.key });
    expect(workRefFromAddress({ ...merged, resolution: undefined })).toEqual({
      kind: 'moved',
      slug: canonical.key,
    });
    expect(workRefFromAddress({ ...merged, state: 'current' })).toEqual({
      kind: 'moved',
      slug: canonical.key,
    });
    expect(workRefFromAddress({ ...merged, state: 'current', resolution: undefined })).toEqual({
      kind: 'work',
      id: uuid,
    });
    const resolve = async () => ({ kind: 'resolved' as const, data: merged });
    const suffix = { search: '?language=sv&version=first', hash: '#part' };
    const target = canonicalHref(canonical, 'ja', canonical.slugSource, { tail: ['contents'], ...suffix });
    const legacy = canonicalHref({ prefix: '/w/', key: uuid, slugSource: '' }, 'ja', '', {
      tail: ['contents', ''], ...suffix,
    });
    expect(
      await decideAddress(
        new URL(legacy, 'https://rezics.test'),
        'ja',
        resolve,
      ),
    ).toEqual({ kind: 'redirect', status: 301, location: target });
    expect((await decideAddress(new URL(target, 'https://rezics.test'), 'ja', resolve)).kind).toBe(
      'pass',
    );
  });

  test('a merged Work with identity policy keeps its derived final slug', () => {
    const address = {
      prefix: '/w/' as const,
      key: uuidToSid(survivor.slice(-36)),
      slugSource: 'New title',
    };
    expect(workRefFromAddress({ ...merged, canonical: address })).toEqual({
      kind: 'moved',
      slug: `${address.key}-new-title`,
    });
  });

  test('mounted names preserve the owning scope, route and capability mapping', async () => {
    const mounted: ResolvedAddress = {
      ...merged,
      scope: `zone:${survivor}`,
      key: 'old-character',
      canonical: { prefix: `${spaceHref('books', 'site', ['characters'])}/` as CanonicalAddress['prefix'], key: 'キリト', slugSource: 'Kirito' },
      capabilities: undefined,
      resolution: undefined,
    };
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      expect(Object.fromEntries(url.searchParams)).toEqual({
        scope: `zone:${survivor}`,
        key: 'old-character',
        route: 'characters',
      });
      return Response.json(mounted);
    }) as typeof fetch;
    expect(
      await readAddress(
        { scope: `zone:${survivor}`, key: 'old-character', route: 'characters' },
        'ja',
        'https://main.test',
      ),
    ).toEqual({ kind: 'resolved', data: mounted });
    const space = { ...merged, scope: 'space', capabilities: { realm: holder, zone: survivor } };
    expect(resolvedAddress(space)?.capabilities).toEqual(space.capabilities);
  });

  test('unknown, retired and unavailable reads keep distinct outcomes', async () => {
    for (const [status, kind] of [
      [404, 'missing'],
      [410, 'retired'],
      [503, 'unavailable'],
    ] as const) {
      globalThis.fetch = (async () =>
        Response.json(
          { ...merged, status: 'retired', state: 'retired' },
          { status },
        )) as unknown as typeof fetch;
      expect(
        await readAddress({ scope: 'work', key: 'old-story' }, 'en', 'https://main.test'),
      ).toEqual({ kind });
    }
  });

  test('malformed or cross-scope responses never become admitted addresses', async () => {
    for (const bad of [
      { ...merged, scope: 'unknown' },
      { ...merged, state: 'retired' },
      { ...merged, holder: 'https://example.com/private' },
      { ...merged, canonical: { ...canonical, prefix: '//example.com/' } },
      { ...merged, capabilities: { realm: 'not-an-identity' } },
    ])
      expect(resolvedAddress(bad)).toBeNull();
    globalThis.fetch = (async () =>
      Response.json({ ...merged, scope: 'agent' })) as unknown as typeof fetch;
    expect(
      await readAddress({ scope: 'work', key: 'old-story' }, 'en', 'https://main.test'),
    ).toEqual({ kind: 'unavailable' });
  });
});
