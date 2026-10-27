import { expect, test } from 'bun:test';
import { gunzipSync } from 'node:zlib';
import { pageLinks, type PagePaths } from '../src/shell/head.ts';
import { packShards, sitemapIndexXml, type SitemapFamily } from '../src/sitemap/pack.ts';

const locales = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'] as const;
const origin = 'https://public.example';
const maxFamilies = 3_000;
const maxBytes = 40_000_000;
const encoder = new TextEncoder();
const declaration = '<?xml version="1.0" encoding="UTF-8"?>\n';
const urlset =
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">';

function pathsOf(id: string): PagePaths {
  return Object.fromEntries(locales.map((locale) => [locale, `/subjects/${id}-${locale}`])) as PagePaths;
}
function family(index: number, pad = 8, lastmod = '2026-10-27T01:02:03Z'): SitemapFamily {
  return { paths: pathsOf(String(index).padStart(pad, '0')), lastmod };
}
function xmlOf(shard: { gzip: Uint8Array }): string {
  return gunzipSync(shard.gzip).toString('utf8');
}
async function sha24(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 24);
}
// Overhead of one file and the size of one family at a given id width, measured from real output.
async function sizes(pad: number) {
  const [one, two] = await Promise.all([
    packShards(origin, [family(1, pad)]),
    packShards(origin, [family(1, pad), family(2, pad)]),
  ]);
  const perFamily = two[0]!.bytes - one[0]!.bytes;
  return { perFamily, wrapper: one[0]!.bytes - perFamily };
}

test("packShards writes every family's eight locale URLs as entries, each with lastmod and eight reciprocal xhtml:link alternates built by pageLinks, escaped, with no x-default, changefreq or priority", async () => {
  const paths = {
    ...pathsOf('1'),
    en: '/search/a&b',
    ja: `/search/<"x'>`,
  } satisfies PagePaths;
  const shards = await packShards(origin, [{ paths, lastmod: '2026-10-27T09:00:00.789+08:00' }]);
  expect(shards).toHaveLength(1);
  const xml = xmlOf(shards[0]!);

  const escape = (value: string) =>
    value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&apos;');
  const entries = locales.map((locale) => {
    const links = pageLinks(origin, locale, '/', paths);
    const alternates = links.filter((link) => link.rel === 'alternate' && link.hrefLang !== 'x-default');
    expect(alternates).toHaveLength(8);
    return (
      `<url><loc>${escape(links[0]!.href)}</loc><lastmod>2026-10-27T01:00:00Z</lastmod>` +
      alternates
        .map((link) => `<xhtml:link rel="alternate" hreflang="${link.hrefLang}" href="${escape(link.href)}"/>`)
        .join('') +
      '</url>'
    );
  });
  expect(xml).toBe(`${declaration}${urlset}${entries.join('')}</urlset>`);
  expect(xml).toContain('/en/search/a&amp;b');
  expect(xml).toContain('/ja/search/&lt;&quot;x&apos;&gt;');
  expect(xml.match(/<url>/g)).toHaveLength(8);
  expect(xml.match(/<xhtml:link /g)).toHaveLength(64);
  expect(xml).not.toMatch(/x-default|changefreq|priority/);
  expect(shards[0]).toMatchObject({ families: 1, urls: 8, bytes: encoder.encode(xml).length });
});

test('a shard closes before a family that would exceed 3,000 families or 40,000,000 uncompressed bytes including the wrapper, a family never spans two shards, and a family that cannot fit an empty shard throws', async () => {
  // Family count binds with short URLs.
  const many = Array.from({ length: maxFamilies + 1 }, (_, index) => family(index));
  const byCount = await packShards(origin, many);
  expect(byCount.map((shard) => shard.families)).toEqual([maxFamilies, 1]);
  expect(byCount.map((shard) => shard.urls)).toEqual([maxFamilies * 8, 8]);
  expect(xmlOf(byCount[0]!).match(/<url>/g)).toHaveLength(maxFamilies * 8);
  expect(xmlOf(byCount[1]!)).toContain('/subjects/00003000-en');

  // Byte count binds with long URLs: about 290 KB per family.
  const pad = 4_000;
  const { perFamily, wrapper } = await sizes(pad);
  const long = Array.from({ length: 300 }, (_, index) => family(index, pad));
  const byBytes = await packShards(origin, long);
  expect(byBytes.length).toBeGreaterThan(1);
  expect(byBytes.reduce((sum, shard) => sum + shard.families, 0)).toBe(300);
  let next = 0;
  for (const [position, shard] of byBytes.entries()) {
    expect(shard.bytes).toBe(wrapper + shard.families * perFamily);
    expect(shard.bytes).toBeLessThanOrEqual(maxBytes);
    expect(shard.urls).toBe(shard.families * 8);
    if (position < byBytes.length - 1) expect(shard.bytes + perFamily).toBeGreaterThan(maxBytes);
    const xml = xmlOf(shard);
    expect(xml.match(/<url>/g)).toHaveLength(shard.families * 8);
    // Families keep their order and each family's eight records stay in one file.
    for (let index = next; index < next + shard.families; index++) {
      expect(xml).toContain(`/subjects/${String(index).padStart(pad, '0')}-en`);
    }
    expect(xml).not.toContain(`/subjects/${String(next + shard.families).padStart(pad, '0')}-en`);
    next += shard.families;
  }

  // One family that cannot fit an empty shard is an error, never truncated.
  const oversized = { paths: pathsOf('x'.repeat(600_000)), lastmod: '2026-10-27T01:02:03Z' };
  await expect(packShards(origin, [family(1), oversized])).rejects.toThrow(/x{20}/);
  await expect(packShards(origin, [family(1), oversized])).rejects.toThrow(/too large|cannot fit|exceed/i);
}, 120_000);

test('a family missing a locale, a duplicate URL, an invalid lastmod or an origin that is not absolute https throws', async () => {
  const good = family(1);
  const { ja: _removed, ...partial } = good.paths;
  await expect(packShards(origin, [good, { ...family(2), paths: partial as PagePaths }])).rejects.toThrow(/ja/);
  await expect(packShards(origin, [good, { ...family(2), paths: partial as PagePaths }])).rejects.toThrow(
    /subjects\/00000002/,
  );

  await expect(packShards(origin, [good, family(2), good])).rejects.toThrow(/duplicate/i);
  await expect(packShards(origin, [good, family(2), good])).rejects.toThrow(/subjects\/00000001/);
  const sharing = { paths: { ...pathsOf('9'), fr: good.paths.fr }, lastmod: good.lastmod };
  await expect(packShards(origin, [good, sharing])).rejects.toThrow(/duplicate/i);

  for (const lastmod of [
    '',
    'yesterday',
    '2026-10-27',
    '2026-10-27T01:02:03',
    '2026-13-01T00:00:00Z',
    '2026-02-30T00:00:00Z',
    '2026-10-27T25:00:00Z',
  ]) {
    await expect(packShards(origin, [good, { ...family(2), lastmod }])).rejects.toThrow(/lastmod/i);
    await expect(packShards(origin, [good, { ...family(2), lastmod }])).rejects.toThrow(/subjects\/00000002/);
  }
  const accepted = await packShards(origin, [{ ...good, lastmod: '2026-10-27T01:02:03.456Z' }]);
  expect(xmlOf(accepted[0]!)).toContain('<lastmod>2026-10-27T01:02:03Z</lastmod>');

  for (const bad of [
    '',
    'public.example',
    'http://public.example',
    'https://public.example/',
    'https://public.example/path',
    'https://public.example?a=1',
    '/relative',
  ]) {
    await expect(packShards(bad, [good])).rejects.toThrow(/origin/i);
    expect(() => sitemapIndexXml(bad, [{ path: '/sitemap-a.xml.gz', lastmod: good.lastmod }])).toThrow(/origin/i);
  }
  await expect(packShards('https://public.example:8443', [good])).resolves.toHaveLength(1);

  await expect(packShards(origin, [{ ...good, paths: { ...good.paths, en: '/subjects/a\u0001b' } }])).rejects.toThrow(
    /subjects/,
  );
  expect(await packShards(origin, [])).toEqual([]);
});

test('each shard is gzip whose decompressed bytes are the counted XML, with a digest that is equal for equal input and differs otherwise', async () => {
  const families = Array.from({ length: 50 }, (_, index) => family(index));
  const shards = await packShards(origin, families);
  expect(shards).toHaveLength(1);
  const shard = shards[0]!;
  expect(shard.gzip.slice(0, 2)).toEqual(new Uint8Array([0x1f, 0x8b]));
  const bytes = gunzipSync(shard.gzip);
  expect(bytes.length).toBe(shard.bytes);
  const xml = bytes.toString('utf8');
  expect(xml.startsWith(`${declaration}${urlset}`)).toBe(true);
  expect(xml.endsWith('</urlset>')).toBe(true);
  expect(shard.digest).toMatch(/^[0-9a-f]{24}$/);
  expect(shard.digest).toBe(await sha24(shard.gzip));
  expect(shard.gzip.length).toBeLessThan(shard.bytes / 4);

  const again = await packShards(
    origin,
    families.map((entry) => ({ ...entry, paths: { ...entry.paths } })),
  );
  expect(again[0]!.digest).toBe(shard.digest);
  expect(Buffer.from(again[0]!.gzip).equals(Buffer.from(shard.gzip))).toBe(true);

  const touched = await packShards(origin, [
    ...families.slice(0, 49),
    { ...families[49]!, lastmod: '2026-10-28T00:00:00Z' },
  ]);
  expect(touched[0]!.digest).not.toBe(shard.digest);
  const otherOrigin = await packShards('https://other.example', families);
  expect(otherOrigin[0]!.digest).not.toBe(shard.digest);
});

test('sitemapIndexXml writes a flat index of loc and lastmod and throws above 50,000 entries', () => {
  const xml = sitemapIndexXml(origin, [
    { path: '/sitemap-subjects-aaaa.xml.gz', lastmod: '2026-10-27T01:02:03Z' },
    { path: '/sitemap-a&b.xml.gz', lastmod: '2026-10-27T09:00:00+08:00' },
  ]);
  expect(xml).toBe(
    `${declaration}<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
      '<sitemap><loc>https://public.example/sitemap-subjects-aaaa.xml.gz</loc><lastmod>2026-10-27T01:02:03Z</lastmod></sitemap>' +
      '<sitemap><loc>https://public.example/sitemap-a&amp;b.xml.gz</loc><lastmod>2026-10-27T01:00:00Z</lastmod></sitemap>' +
      '</sitemapindex>',
  );

  const entries = (count: number) =>
    Array.from({ length: count }, (_, index) => ({ path: `/s-${index}.xml.gz`, lastmod: '2026-10-27T01:02:03Z' }));
  expect(sitemapIndexXml(origin, entries(50_000)).match(/<sitemap>/g)).toHaveLength(50_000);
  expect(() => sitemapIndexXml(origin, entries(50_001))).toThrow(/50,?000/);
  // Byte ceiling, and an index never nests or stays empty.
  const heavy = Array.from({ length: 100 }, (_, index) => ({
    path: `/${index}-${'x'.repeat(500_000)}.xml.gz`,
    lastmod: '2026-10-27T01:02:03Z',
  }));
  expect(() => sitemapIndexXml(origin, heavy)).toThrow(/40,?000,?000|bytes/i);
  expect(() => sitemapIndexXml(origin, [])).toThrow();
  expect(() => sitemapIndexXml(origin, [{ path: 'sitemap.xml.gz', lastmod: '2026-10-27T01:02:03Z' }])).toThrow(/path/i);
  expect(() => sitemapIndexXml(origin, [{ path: '/s.xml.gz', lastmod: 'soon' }])).toThrow(/lastmod/i);
});

test('growth check: shard count and uncompressed bytes grow linearly in families and no shard exceeds its limits', async () => {
  const totals: number[] = [];
  const counts: number[] = [];
  for (const count of [300, 3_000, 30_000]) {
    const shards = await packShards(
      origin,
      Array.from({ length: count }, (_, index) => family(index)),
    );
    counts.push(shards.length);
    totals.push(shards.reduce((sum, shard) => sum + shard.bytes, 0));
    expect(shards.reduce((sum, shard) => sum + shard.families, 0)).toBe(count);
    for (const shard of shards) {
      expect(shard.families).toBeLessThanOrEqual(maxFamilies);
      expect(shard.bytes).toBeLessThanOrEqual(maxBytes);
    }
  }
  expect(counts).toEqual([1, 1, 10]);
  expect(totals[1]! / totals[0]!).toBeGreaterThan(9.9);
  expect(totals[1]! / totals[0]!).toBeLessThan(10.1);
  expect(totals[2]! / totals[1]!).toBeGreaterThan(9.9);
  expect(totals[2]! / totals[1]!).toBeLessThan(10.1);
}, 180_000);
