import { expect, test } from 'bun:test';
import { animeMangaSamplePlan, approveCataloguePackage, cataloguePackageDigest } from './anime-manga-zones-step.ts';
import type { HttpResult, SeedPort } from './vn-catalogue-step.ts';

const native = (suffix: string) => `https://rezics.com/id/00000000-0000-4000-a000-${suffix.padStart(12, '0')}`;

test('the sample has a page of each format filter, mixed languages, a long series and the absent cases', () => {
  const plan = animeMangaSamplePlan();
  const anime = plan.filter(sample => sample.zone === 'anime');
  const manga = plan.filter(sample => sample.zone === 'manga');
  const platform = (sample: (typeof plan)[number]) =>
    sample.subject.kind === 'bangumi' ? sample.subject.source.platform : null;
  const tags = (sample: (typeof plan)[number]) =>
    sample.subject.kind === 'bangumi' ? sample.subject.source.meta_tags ?? [] : [];

  expect(anime.filter(sample => platform(sample) === 1)).toHaveLength(22);
  expect(manga.filter(sample => platform(sample) === 1001)).toHaveLength(22);
  expect(anime.map(platform)).toEqual(expect.arrayContaining([1, 2, 3, 4, 5, 99]));
  expect(manga.some(sample => sample.subject.kind === 'one-shot')).toBe(true);
  expect(manga.map(platform)).toContain(999);
  expect(plan.some(sample => sample.language === 'ja')).toBe(true);
  expect(plan.some(sample => sample.language === 'en')).toBe(true);

  const long = plan.find(sample => sample.key === 'long-tv');
  expect(long?.subject.kind === 'bangumi' && long.subject.source.eps).toBe(1155);
  expect(long?.year).toBe(1980);
  expect(plan.find(sample => sample.key === 'long-manga')?.year).toBe(1995);
  expect(anime.filter(sample => tags(sample).includes('未放送')).map(sample => sample.year)).toEqual([1981]);
  expect(anime.some(sample => tags(sample).includes('取消'))).toBe(true);
  expect(manga.some(sample => tags(sample).includes('未发售'))).toBe(true);
  expect(manga.some(sample => tags(sample).includes('腰斩'))).toBe(true);
  expect(plan.filter(sample => sample.year === null).map(sample => sample.key).sort()).toEqual([
    'anime-unclassified', 'manga-3', 'manga-unclassified', 'one-shot-en', 'tv-3',
  ]);
  expect(new Set(plan.map(sample => sample.key)).size).toBe(plan.length);
});

test('package approval asks another account to review, and names only admitted slots', async () => {
  const ownerCalls: string[] = [];
  const reviewCalls: { path: string; body: unknown }[] = [];
  let postedDigest = '';
  const theme = native('10');
  const zone = native('11');
  const revision = native('12');
  const owner: SeedPort = {
    actingSubject: native('1'),
    request: async (method, path, body) => {
      ownerCalls.push(`${method} ${path.split('?')[0]}`);
      if (method === 'POST' && path === '/v1/themes') return { status: 201, body: { theme } };
      if (method === 'POST' && path.includes('/revisions') && !path.includes('/reviews')) {
        const bundle = (body as { bundle: { slots: string[]; packageDigest: string } }).bundle;
        expect(bundle.slots).toEqual(['workCard', 'footer']);
        postedDigest = bundle.packageDigest;
        return { status: 201, body: { operation: revision } };
      }
      if (method === 'POST' && path.includes('/first-party-activations')) return { status: 201, body: {} };
      if (method === 'GET' && path.startsWith('/v1/zones/')) {
        return { status: 200, body: { revision: native('13'), name: 'Anime', language: 'en',
          configuration: { defaultRealm: native('14'), official: {}, presentation: { profile: 'zone-presentation-v2' } } } };
      }
      if (method === 'PUT') {
        const presentation = (body as { presentation?: { official?: { theme?: string } } }).presentation;
        expect(presentation?.official?.theme).toMatch(/^https:\/\/rezics\.com\/id\//);
        return { status: 200, body: {} };
      }
      return { status: 500, body: { unexpected: path } } satisfies HttpResult;
    },
    grant: async () => {},
  };
  await approveCataloguePackage(owner, {
    zone, slug: 'anime', owner: owner.actingSubject, reviewer: native('2'),
    review: async (method, path, body) => {
      reviewCalls.push({ path, body });
      expect(method).toBe('POST');
      return { status: 201, body: {} };
    },
  });
  expect(ownerCalls.some(call => call.includes('/reviews'))).toBe(false);
  expect(reviewCalls).toHaveLength(1);
  expect(reviewCalls[0]?.path).toContain(`/revisions/${revision.slice(-36)}/reviews`);
  expect(reviewCalls[0]?.body).toMatchObject({ decision: 'approved', actingSubject: native('2') });
  const posted = ownerCalls.find(call => call.startsWith('POST /v1/themes/'));
  expect(posted).toBeDefined();
  const animeDigest = await cataloguePackageDigest('anime');
  const mangaDigest = await cataloguePackageDigest('manga');
  expect(postedDigest).toBe(animeDigest);
  expect(animeDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(mangaDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(animeDigest).not.toBe(mangaDigest);
});
