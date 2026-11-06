import { expect, test } from 'bun:test';
import { Compile } from 'typebox/compile';
import {
  decodeDiscoveryCursor,
  discoveryDescription,
  discoveryLimit,
  discoveryWindow,
  encodeDiscoveryCursor,
  type DiscoveryCursorContext,
} from '../../src/community/discovery.ts';
import { discoveryQuerySchema, discoveryResponseSchema } from '../../src/community/schemas.ts';
import { ProblemError } from '../../src/http/problem.ts';
import { newId } from '../../src/route/route.ts';

const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(51)]]) };
const now = Date.parse('2026-10-31T12:00:00.000Z');
const context: DiscoveryCursorContext = {
  sort: 'popular',
  cutoff: '2026-10-31',
  partitionEpoch: 2,
  publicationEpoch: 'publication-generation',
};

test('Popular and Trending use complete UTC days across month and leap-day boundaries', () => {
  // The offset is already March locally, but the current UTC day is still February 29.
  const at = new Date('2024-03-01T01:00:00+08:00');
  expect(discoveryWindow('popular', at)).toEqual({ from: '2024-01-30', cutoff: '2024-02-29' });
  expect(discoveryWindow('trending', at)).toEqual({ from: '2024-02-28', cutoff: '2024-02-29' });
  expect(discoveryWindow('popular', new Date('2026-10-31T23:59:59.999Z'))).toEqual({
    from: '2026-10-01',
    cutoff: '2026-10-31',
  });
  expect(discoveryWindow('trending', new Date('2026-11-01T00:00:00.000Z'))).toEqual({
    from: '2026-10-31',
    cutoff: '2026-11-01',
  });
  expect(() => discoveryWindow('popular', new Date(NaN))).toThrow(TypeError);
});

test('discovery accepts standard limits while bounding examined candidates to twenty', () => {
  const query = Compile(discoveryQuerySchema);
  expect(query.Check({ sort: 'popular' })).toBe(true);
  expect(query.Check({ sort: 'trending', limit: 100 })).toBe(true);
  expect(discoveryLimit()).toEqual({ limit: 20, candidates: 20 });
  expect(discoveryLimit(1)).toEqual({ limit: 1, candidates: 1 });
  expect(discoveryLimit(100)).toEqual({ limit: 100, candidates: 20 });
  for (const limit of [0, 101, 1.5, NaN]) {
    expect(() => discoveryLimit(limit)).toThrow(ProblemError);
    expect(query.Check({ sort: 'popular', limit })).toBe(false);
  }
  expect(query.Check({ sort: 'recent' })).toBe(false);
  expect(query.Check({ sort: 'popular', accountId: newId(1) })).toBe(false);
});

test('signed continuation retains the last examined rank and rejects changed query or stale generations', () => {
  const position = { count: '9007199254740993', realmId: newId(0x1234) };
  const cursor = encodeDiscoveryCursor(tokens, context, position, now);
  // This same continuation is usable for a sparse or empty page: visible output is not its position.
  expect(decodeDiscoveryCursor(tokens, { ...context, limit: 20 }, cursor, now)).toEqual(position);
  for (const current of [
    { ...context, cutoff: '2026-11-01' },
    { ...context, partitionEpoch: 3 },
    { ...context, publicationEpoch: 'next-publication-generation' },
  ]) {
    expect(() => decodeDiscoveryCursor(tokens, current, cursor, now)).toThrow(
      expect.objectContaining({ code: 'stale_cursor' }),
    );
  }
  for (const current of [
    { ...context, sort: 'trending' as const },
    { ...context, limit: 100 },
  ]) {
    expect(() => decodeDiscoveryCursor(tokens, current, cursor, now)).toThrow(
      expect.objectContaining({ code: 'invalid_cursor' }),
    );
  }
  for (const invalid of [position.realmId, `${cursor.slice(0, -1)}!`]) {
    expect(() => decodeDiscoveryCursor(tokens, context, invalid, now)).toThrow(
      expect.objectContaining({ code: 'invalid_cursor' }),
    );
  }
  expect(() => encodeDiscoveryCursor(tokens, context, { ...position, count: '0' }, now)).toThrow(TypeError);
});

test('discovery summaries collapse whitespace and truncate Unicode characters with an unavailable avatar', () => {
  expect(discoveryDescription(' \n A\t\tcommunity\u2003summary \r ')).toBe('A community summary');
  expect(discoveryDescription('😀'.repeat(161))).toBe('😀'.repeat(160));
  const card = {
    realmId: newId(0x1234),
    spaceId: newId(0x1234),
    name: 'A Realm',
    description: discoveryDescription(' A summary '),
    avatar: null,
  };
  const response = Compile(discoveryResponseSchema());
  expect(response.Check({ realms: [card], next: null })).toBe(true);
  expect(response.Check({ realms: [], next: 'signed-continuation' })).toBe(true);
  expect(response.Check({ items: [card], next: null })).toBe(false);
  expect(response.Check({ realms: [{ ...card, avatar: 'https://example.com/avatar' }], next: null })).toBe(false);
  for (const extra of [{ count: 1 }, { score: 1 }, { accountId: newId(1) }]) {
    expect(response.Check({ realms: [{ ...card, ...extra }], next: null })).toBe(false);
  }
});

test('discovery accepts only the exact native image summary in its existing closed card', () => {
  const response = Compile(discoveryResponseSchema());
  const avatar = {
    id: newId(0x1234),
    containerId: newId(0x1234),
    digest: 'a'.repeat(64),
    width: 96,
    height: 48,
    variants: [{ format: 'webp', width: 96, height: 48 }],
    placeholder: null,
    focalPoint: null,
    credit: null,
  };
  const card = { realmId: avatar.containerId, spaceId: newId(0x1234), name: 'Realm', description: '', avatar };
  expect(response.Check({ realms: [card], next: null })).toBe(true);
  for (const image of [
    { ...avatar, originalUrl: 'https://example.com/original' },
    { ...avatar, digest: 'fake-hash' },
    { ...avatar, variants: [] },
    { ...avatar, variants: [{ ...avatar.variants[0], key: 'private/storage/key' }] },
    { ...avatar, permission: true },
  ]) {
    expect(response.Check({ realms: [{ ...card, avatar: image }], next: null })).toBe(false);
  }
});

test('the assigned real current-authorized journey binds its native source while privacy retry and request bounds remain meaningful', async () => {
  const { createHash } = await import('node:crypto');
  const { default: sharp } = await import('sharp');
  const { mediaRealmDownloadFixture } = await import('../content/media-realm-download-fixture.ts');
  const { createImageJob } = await import('../../src/content/image-job.ts');
  const { readRealmPresentationImages } = await import('../../src/content/realm-media.ts');
  const { actionCatalogue } = await import('../../src/http/request.ts');
  const { testAccess, testKernel } = await import('../support/test-kernel.ts');
  const { listRealmDiscovery } = await import('../../src/community/discovery.ts');
  const { projectRealmDiscovery } = await import('../../src/community/discovery-projection.ts');
  const fixture = await mediaRealmDownloadFixture();
  try {
    const realmId = fixture.publicRealm.realmId;
    const auth = {
      ...fixture.auth.host.service.verifier,
      fetch: (url: string | URL, init?: RequestInit) => fixture.auth.host.service.handler(new Request(url, init)),
    };
    const access = testAccess({ pool: fixture.db.pool, actions: actionCatalogue(fixture.kernel), auth });
    // Existing fixture discussion starts are real native source records. Read the
    // next complete day without changing their original qualification or counts.
    const clock = () => new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000 + 86_400_000);
    while (await projectRealmDiscovery(fixture.db.pool, realmId, { clock })) {
      /* existing bounded committed-source steps */
    }
    const nativeKernel = testKernel({ pool: fixture.db.pool, auth, clock });
    const path = '/v1/realms/discovery?sort=popular&limit=1';
    const wire = async () => {
      const response = await nativeKernel.handle(new Request(`http://kernel.test${path}`));
      expect(response.status).toBe(200);
      const value: unknown = await response.json();
      expect(Compile(discoveryResponseSchema()).Check(value)).toBe(true);
      return value as import('../../src/community/discovery.ts').DiscoveryPage;
    };
    const read = (currentAccess = access, cursor?: string) =>
      listRealmDiscovery({ pool: fixture.db.pool, access: currentAccess, tokens, clock }, Date.now() + 30_000, {
        sort: 'popular',
        limit: 1,
        ...(cursor === undefined ? {} : { cursor }),
      });
    expect((await wire()).realms[0]?.avatar).toBeNull();
    const bytes = await sharp({ create: { width: 96, height: 48, channels: 3, background: '#123456' } })
      .png()
      .toBuffer();
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const key = crypto.randomUUID();
    const { media } = await fixture.checked(
      'POST',
      `/v1/realms/${realmId}/media`,
      {
        purpose: 'realm-icon',
        mediaType: 'image/png',
        byteCount: bytes.length,
        sha256,
      },
      201,
      { key },
    );
    const imageId: string = media.id;
    await fixture.storage.storage.put(`m/${imageId}/original`, bytes, { mediaType: 'image/png' });
    await fixture.checked(
      'POST',
      `/v1/media/${imageId}:complete`,
      {
        containerId: realmId,
        reservationRequestId: key,
        byteCount: bytes.length,
        sha256,
      },
      200,
      { bearer: fixture.governor.websiteBearer },
    );
    expect((await createImageJob(fixture.db.pool, fixture.storage.storage).process(imageId)).state).toBe('available');
    const select = async (avatarMediaId: string | null) => {
      const current = await fixture.readRealm(realmId, fixture.governor.bearer);
      await fixture.checked(
        'PATCH',
        `/v1/realms/${realmId}`,
        {
          presentation: { avatarMediaId, bannerMediaId: null, rules: null },
        },
        200,
        { headers: { 'if-match': JSON.stringify(current.value.realm.headRevisionId) } },
      );
    };
    await select(imageId);
    const native = await readRealmPresentationImages(
      { clock: () => new Date(), pool: fixture.db.pool, access },
      {
        realmId,
        avatarMediaId: imageId,
        bannerMediaId: null,
      },
      { actor: { kind: 'anonymous' }, deadline: Date.now() + 30_000 },
    );
    expect(native.avatar.state).toBe('available');
    const selected = await wire();
    expect(selected.realms).toHaveLength(1);
    expect(selected.realms[0]?.avatar).toEqual(native.avatar.value);
    expect(selected.realms[0]?.avatar).toMatchObject({ id: imageId, containerId: realmId, width: 96, height: 48 });
    expect(JSON.stringify(selected)).not.toMatch(/original|sourceUrl|uploader|permission|"key"/);
    expect(selected.next).not.toBeNull();

    let mediaReads = 0;
    let failMedia = false;
    let privatize = false;
    let replaceSelection = false;
    const observed: import('../../src/request/access.ts').Access = {
      ...access,
      async prepare(actor, action, resource, context) {
        if (action === 'media:read') {
          expect(actor).toEqual({ kind: 'anonymous' });
          expect(resource.id).toBe(imageId);
          mediaReads++;
          if (failMedia) throw new Error('Optional native source temporarily unavailable');
        }
        return access.prepare?.(actor, action, resource, context);
      },
      async authorize(client, actor, action, resource, evidence, at) {
        const allowed = await access.authorize(client, actor, action, resource, evidence, at);
        if (action === 'media:read' && allowed && (privatize || replaceSelection)) {
          const current = await fixture.call('GET', `/v1/realms/${realmId}`, {
            bearer: fixture.governor.bearer,
            kernel: fixture.mutationKernel,
          });
          expect(current.response.status).toBe(200);
          // The one-connection source pool is checked out; mutate through the
          // fixture's independent existing native command pool.
          await fixture.checked(
            'PATCH',
            `/v1/realms/${realmId}`,
            privatize
              ? { visibility: 'protected' }
              : {
                  presentation: { avatarMediaId: null, bannerMediaId: null, rules: null },
                },
            200,
            {
              kernel: fixture.mutationKernel,
              headers: { 'if-match': JSON.stringify(current.value.realm.headRevisionId) },
            },
          );
          privatize = false;
          replaceSelection = false;
        }
        return allowed;
      },
    };
    // Retry keeps the original one-candidate range and nullable image contract.
    failMedia = true;
    expect((await read(observed)).realms[0]?.avatar).toBeNull();
    expect(mediaReads).toBe(1);
    failMedia = false;
    expect((await read(observed)).realms[0]?.avatar).toEqual(native.avatar.value);
    expect(mediaReads).toBe(2);
    const continuation = await read(observed);
    expect((await read(observed, continuation.next!)).realms).toEqual([]);
    expect(mediaReads).toBe(3); // no source read or refill past the examined range

    replaceSelection = true;
    expect((await read(observed)).realms).toEqual([]); // final head/selection binding changed
    expect((await read()).realms[0]?.avatar).toBeNull();
    await select(imageId);
    privatize = true;
    const sparse = await read(observed);
    expect(sparse.realms).toEqual([]);
    expect(sparse.next).not.toBeNull();
    expect((await read()).realms).toEqual([]); // retry cannot revive an unreadable Realm
  } finally {
    await fixture.close();
  }
}, 240_000);
