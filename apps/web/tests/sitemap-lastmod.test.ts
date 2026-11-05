import { expect, test } from 'bun:test';
import { gunzipSync } from 'node:zlib';
import { pageLinks, type PagePaths } from '../src/shell/head.ts';
import { packShards } from '../src/sitemap/pack.ts';

const locales = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'] as const;
const origin = 'https://public.example';

function pathsOf(id: string): PagePaths {
  return Object.fromEntries(locales.map((locale) => [locale, `/subjects/${id}-${locale}`])) as PagePaths;
}

test('a family without lastmod is written as eight url entries with their alternates and no lastmod element, and a family with one keeps it', async () => {
  const unknown = { paths: pathsOf('unknown') };
  const known = { paths: pathsOf('known'), lastmod: '2026-10-27T09:00:00.789+08:00' };
  const shards = await packShards(origin, [unknown, known]);
  expect(shards).toHaveLength(1);
  const xml = gunzipSync(shards[0]!.gzip).toString('utf8');
  const entries = xml.match(/<url>.*?<\/url>/g)!;
  expect(entries).toHaveLength(16);
  for (const [familyIndex, family] of [unknown, known].entries()) {
    for (const [localeIndex, locale] of locales.entries()) {
      const links = pageLinks(origin, locale, '/', family.paths);
      const alternates = links
        .filter((link) => link.rel === 'alternate' && link.hrefLang !== 'x-default')
        .map((link) => `<xhtml:link rel="alternate" hreflang="${link.hrefLang}" href="${link.href}"/>`)
        .join('');
      const lastmod = familyIndex === 0 ? '' : '<lastmod>2026-10-27T01:00:00Z</lastmod>';
      expect(entries[familyIndex * 8 + localeIndex]).toBe(
        `<url><loc>${links[0]!.href}</loc>${lastmod}${alternates}</url>`,
      );
    }
  }
  expect(xml.match(/<lastmod>/g)).toHaveLength(8);
  expect(xml.match(/<xhtml:link /g)).toHaveLength(128);
  expect(xml).not.toContain('x-default');
  expect(shards[0]).toMatchObject({ families: 2, urls: 16, bytes: new TextEncoder().encode(xml).length });
});

test('a family whose lastmod is present but not a valid time still throws, naming the family', async () => {
  for (const lastmod of ['', 'yesterday', '2026-10-27', '2026-10-27T01:02:03', '2026-02-30T00:00:00Z']) {
    await expect(packShards(origin, [{ paths: pathsOf('invalid'), lastmod }])).rejects.toThrow(
      /family .*subjects\/invalid-en.*invalid lastmod/,
    );
  }
});

test('the shard bytes, limits and digest for families that all carry lastmod are unchanged from base', async () => {
  // Captured before changing the packer: short paths bind on family count, long paths on bytes.
  const cases = [
    {
      count: 3_001,
      pad: 8,
      expected: [
        { digest: 'f52932e34f8bafe777bfbfda', families: 3_000, urls: 24_000, bytes: 21_972_151 },
        { digest: '1f88458029d11841d8018358', families: 1, urls: 8, bytes: 7_475 },
      ],
    },
    {
      count: 140,
      pad: 4_000,
      expected: [
        { digest: 'be5d2977b51ce8885bf1cd4e', families: 135, urls: 1_080, bytes: 39_791_131 },
        { digest: '008c15afb64c6242b86f0a23', families: 5, urls: 40, bytes: 1_473_891 },
      ],
    },
  ];
  for (const { count, pad, expected } of cases) {
    const shards = await packShards(
      origin,
      Array.from({ length: count }, (_, index) => ({
        paths: pathsOf(String(index).padStart(pad, '0')),
        lastmod: '2026-10-27T01:02:03Z',
      })),
    );
    expect(shards.map(({ gzip: _gzip, ...metadata }) => metadata)).toEqual(expected);
    for (const shard of shards) {
      expect(gunzipSync(shard.gzip).length).toBe(shard.bytes);
      expect(shard.families).toBeLessThanOrEqual(3_000);
      expect(shard.bytes).toBeLessThanOrEqual(40_000_000);
    }
  }
});
