import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import data from './fixtures/web-publication.json';
import type {
  Persona,
  PublicationFixture,
  PublishedSubject,
  RelationView,
  SitemapKind,
  WebPublicationDriver,
} from './web-publication-driver';

setDefaultTimeout(180_000);
let driver: WebPublicationDriver;
let fixture: PublicationFixture;
let current: WebPublicationDriver | undefined;
beforeEach(async () => {
  const location = process.env.WEB_PUBLICATION_DRIVER;
  if (!location) throw new Error('Web publication driver is required');
  if (!isAbsolute(location) && !location.startsWith('file:')) {
    throw new Error('WEB_PUBLICATION_DRIVER must be an absolute path or file URL');
  }
  const url = isAbsolute(location) ? pathToFileURL(location) : new URL(location);
  if (url.protocol !== 'file:') throw new Error('Web publication driver must use a file URL');
  const binding = await import(url.href);
  if (typeof binding.createWebPublicationDriver !== 'function') {
    throw new Error('Web publication driver must export createWebPublicationDriver');
  }
  current = driver = await binding.createWebPublicationDriver();
  fixture = await driver.provision(data);
  expect(fixture.releaseDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  await driver.settle();
});
afterEach(async () => {
  const closing = current;
  current = undefined;
  await closing?.close();
});

const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s: string) =>
  s.replace(/&#(x[0-9a-f]+|\d+);|&(amp|lt|gt|quot|apos|nbsp);/gi, (_, n, name) =>
    n
      ? String.fromCodePoint(n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n))
      : (entities[String(name).toLowerCase()] ?? _),
  );
interface ElementValue {
  attrs: Record<string, string>;
  content: string;
}
/** Parse real served markup with Bun's HTML parser, not kernel DTOs. */
async function elements(html: string, selector: string): Promise<ElementValue[]> {
  const found: ElementValue[] = [];
  const active: ElementValue[] = [];
  await new HTMLRewriter()
    .on(selector, {
      element(element) {
        const value = { attrs: Object.fromEntries(element.attributes), content: '' };
        found.push(value);
        if (element.canHaveContent) {
          active.push(value);
          element.onEndTag(() => {
            active.splice(active.indexOf(value), 1);
          });
        }
      },
      text(chunk) {
        for (const value of active) value.content += chunk.text;
      },
    })
    .transform(new Response(html))
    .text();
  return found.map((value) => ({ ...value, content: decode(value.content).replace(/\s+/g, ' ').trim() }));
}
async function document(url: string, persona: Persona = 'anonymous', status = 200) {
  const response = await driver.request(url, persona);
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type')).toContain('text/html');
  const html = await response.text();
  expect((await elements(html, 'main')).length).toBe(1);
  return { response, html, visible: (await elements(html, 'main'))[0]!.content };
}
const absolute = (href: string, base = fixture.publicOrigin) => new URL(href, base).href;
async function links(html: string, selector = 'main a[href]') {
  return (await elements(html, selector)).map((a) => ({ href: absolute(a.attrs.href!), label: a.content }));
}
async function follow(html: string, url: string, persona: Persona = 'anonymous') {
  expect((await links(html)).map((a) => a.href)).toContain(absolute(url));
  return document(url, persona);
}
async function traverse(view: RelationView) {
  const overview = await document(view === 'inverse' ? fixture.subjects.person : fixture.subjects.book);
  const first = fixture.views[view];
  expect((await links(overview.html)).map((a) => a.href)).toContain(absolute(first));
  const targets = Array.from({ length: data.traversal.countPerView }, (_, index) => {
    const url = fixture.subjects[`${view}-${String(index + 1).padStart(3, '0')}`];
    expect(url).toBeDefined();
    return absolute(url!);
  });
  expect(new Set(targets).size).toBe(data.traversal.countPerView);
  const excluded = fixture.subjects[`${view}-withheld`];
  expect(excluded).toBeDefined();
  const seenPages = new Set<string>();
  const reached: string[] = [];
  let next: string | undefined = absolute(first);
  while (next) {
    expect(seenPages.has(next)).toBe(false);
    seenPages.add(next);
    expect(seenPages.size).toBeLessThanOrEqual(targets.length + 1);
    const page = await document(next);
    const pageLinks = await links(page.html);
    const emitted = pageLinks.filter((a) => targets.includes(a.href)).map((a) => a.href);
    expect(emitted.length).toBeGreaterThan(0);
    expect(emitted.length).toBeLessThanOrEqual(data.traversal.maximumPageSize);
    expect(pageLinks.map((a) => a.href)).not.toContain(absolute(excluded!));
    reached.push(...emitted);
    const continuations = await elements(page.html, 'a[rel~="next"]');
    expect(continuations.length).toBeLessThanOrEqual(1);
    next = continuations[0] ? absolute(continuations[0].attrs.href!) : undefined;
  }
  expect(seenPages.size).toBeGreaterThan(1);
  expect(reached).toEqual(targets);
  expect(new Set(reached).size).toBe(reached.length);
}

describe('subject-traversal', () => {
  test('subject-traversal: editions are reachable once in declared order across full pages', async () => {
    await traverse('editions');
  });
  test('subject-traversal: contents are reachable once in declared order across full pages', async () => {
    await traverse('contents');
  });
  test('subject-traversal: cast is reachable once in declared order across full pages', async () => {
    await traverse('cast');
  });
  test('subject-traversal: crew is reachable once in declared order across full pages', async () => {
    await traverse('crew');
  });
  test('subject-traversal: inverse credits are reachable once in declared order across full pages', async () => {
    await traverse('inverse');
  });
  test('subject-traversal: relations are reachable once in declared order across full pages', async () => {
    await traverse('relations');
  });
  test('subject-traversal: credit character credited name position and spoiler retain their meaning', async () => {
    const page = await document(fixture.qualifiedCredit);
    const credit = data.traversal.credit;
    for (const value of [credit.character, credit.creditedName, credit.role, credit.position])
      expect(page.visible).toContain(value);
    const hidden = await elements(page.html, 'details:not([open])');
    const spoilers = hidden.filter((node) => node.content.includes(credit.spoiler));
    expect(spoilers.length).toBe(1);
    expect(
      (await elements(page.html, 'details:not([open]) summary')).some((node) =>
        /spoiler|show|reveal/i.test(node.content),
      ),
    ).toBe(true);
    // Native details reveal works without JS; the spoiler text belongs inside its
    // closed control and appears nowhere else in the document's reading text.
    expect(page.visible.split(credit.spoiler).length - 1).toBe(1);
  });
  test('subject-traversal: Details reaches competing sourced date and editorial history', async () => {
    await driver.proposeCompetingDate();
    await driver.settle();
    const overview = await document(fixture.subjects.book);
    const details = await follow(overview.html, fixture.details, 'editor');
    const date = data.traversal.date;
    for (const value of [date.original, date.competing, date.sourceOriginal, date.sourceCompeting])
      expect(details.visible).toContain(value);
    const histories = (await links(details.html)).filter((a) => /history/i.test(a.label));
    expect(histories.length).toBeGreaterThan(0);
    const history = await document(histories[0]!.href, 'editor');
    for (const value of [date.original, date.competing, date.sourceCompeting]) expect(history.visible).toContain(value);
  });
});

async function metadata(key: PublishedSubject) {
  const expected = data.subjects[key];
  const page = await document(fixture.subjects[key]);
  const title = await elements(page.html, 'title');
  expect(title.length).toBe(1);
  expect(title[0]!.content).toContain(expected.title);
  expect(page.visible).toContain(expected.title);
  expect(page.visible).toContain(expected.description);
  expect((await elements(page.html, 'html'))[0]!.attrs.lang).toBe('en');
  const canonical = await elements(page.html, 'link[rel="canonical"]');
  expect(canonical.map((v) => v.attrs.href)).toEqual([absolute(fixture.subjects[key])]);
  for (const [selector, value] of [
    ['meta[name="description"]', expected.description],
    ['meta[property="og:title"]', expected.title],
    ['meta[property="og:description"]', expected.description],
    ['meta[property="og:url"]', absolute(fixture.subjects[key])],
    ['meta[name="twitter:title"]', expected.title],
    ['meta[name="twitter:description"]', expected.description],
  ]) {
    const tags = await elements(page.html, selector!);
    expect(tags.length).toBe(1);
    expect(decode(tags[0]!.attrs.content!)).toContain(value!);
  }
  for (const selector of [
    'meta[property="og:type"]',
    'meta[property="og:image"]',
    'meta[name="twitter:card"]',
    'meta[name="twitter:image"]',
  ]) {
    expect((await elements(page.html, selector))[0]?.attrs.content).toBeTruthy();
  }
  const alternates = await elements(page.html, 'link[rel="alternate"][hreflang]');
  for (const locale of [...data.locales, 'x-default'])
    expect(alternates.filter((v) => v.attrs.hreflang === locale).length).toBe(1);
  const scripts = await elements(page.html, 'script[type="application/ld+json"]');
  expect(scripts.length).toBe(1);
  const graph = JSON.parse(scripts[0]!.content);
  const nodes = Array.isArray(graph) ? graph : (graph['@graph'] ?? [graph]);
  const subject = nodes.find((node: Record<string, unknown>) => node.name === expected.title);
  expect(subject).toBeDefined();
  expect([expected.schemaOrgType, `https://schema.org/${expected.schemaOrgType}`]).toContain(subject['@type']);
  expect(subject.url ?? subject['@id']).toBe(absolute(fixture.subjects[key]));
  for (const value of data.withheld) expect(decode(page.html)).not.toContain(value);
  return { ...page, subject, graph: JSON.stringify(graph) };
}

describe('published-vertical-metadata', () => {
  test('published-vertical-metadata: Book publishes author word count light-novel form and harem tag', async () => {
    const page = await metadata('book');
    const book = data.subjects.book;
    for (const value of [book.author, book.form, book.tag]) {
      expect(page.visible).toContain(value);
      expect(page.graph).toContain(value);
    }
    expect(page.subject.wordCount).toBe(book.wordCount);
    expect(page.visible.replace(/[,\s]/g, '')).toContain(String(book.wordCount));
    expect(JSON.stringify(page.subject.author)).toContain(book.author);
  });
  test('published-vertical-metadata: Recipe publishes instructions diet and PT25M cook time', async () => {
    const page = await metadata('recipe');
    const recipe = data.subjects.recipe;
    expect(page.subject.cookTime).toBe(recipe.publishedCookTime);
    expect(JSON.stringify(page.subject.suitableForDiet)).toContain('VegetarianDiet');
    expect(page.visible).toContain(recipe.diet);
    expect(page.visible).toMatch(/25\s*(minutes|min)/i);
    for (const instruction of recipe.instructions) {
      expect(page.visible).toContain(instruction);
      expect(JSON.stringify(page.subject.recipeInstructions)).toContain(instruction);
    }
    for (const ingredient of recipe.ingredients) {
      expect(page.visible).toContain(ingredient);
      expect(page.subject.recipeIngredient).toContain(ingredient);
    }
  });
  test('published-vertical-metadata: game metadata agrees with the rendered work', async () => {
    const page = await metadata('game');
    expect(page.visible).toContain(data.subjects.game.platform);
  });
  test('published-vertical-metadata: release metadata preserves release identity and facts', async () => {
    const page = await metadata('release');
    for (const value of [data.subjects.release.platform, data.subjects.release.date])
      expect(page.visible).toContain(value);
  });
  test('published-vertical-metadata: person metadata agrees with the rendered person', async () => {
    await metadata('person');
  });
  test('published-vertical-metadata: organization metadata agrees with the rendered organization', async () => {
    await metadata('organization');
  });
  test('published-vertical-metadata: automated account metadata agrees with the rendered agent', async () => {
    await metadata('automated');
  });
  test('published-vertical-metadata: withheld facts are absent from HTML and JSON-LD', async () => {
    for (const key of Object.keys(data.subjects) as PublishedSubject[]) {
      const page = await document(fixture.subjects[key]);
      for (const value of data.withheld) expect(decode(page.html)).not.toContain(value);
    }
  });
  test('published-vertical-metadata: stale slug redirects to the canonical localized slug', async () => {
    const response = await driver.request(fixture.staleBookZhHans);
    expect(response.status).toBe(301);
    expect(absolute(response.headers.get('location')!)).toBe(absolute(fixture.canonicalBookZhHans));
    const page = await document(fixture.canonicalBookZhHans);
    expect((await elements(page.html, 'html'))[0]!.attrs.lang).toBe('zh-Hans');
    expect(page.visible).toContain(data.subjects.book.zhHansTitle);
    expect((await elements(page.html, 'link[rel="canonical"]'))[0]!.attrs.href).toBe(
      absolute(fixture.canonicalBookZhHans),
    );
  });
  test('published-vertical-metadata: verified agent subject redirects to its handle page', async () => {
    const response = await driver.request(fixture.verifiedSubject);
    expect(response.status).toBe(301);
    expect(absolute(response.headers.get('location')!)).toBe(absolute(fixture.verifiedProfile));
    expect(new URL(absolute(fixture.verifiedProfile)).pathname).toMatch(/^\/en\/@[^/]+$/);
    const page = await document(fixture.verifiedProfile);
    expect((await elements(page.html, 'link[rel="canonical"]'))[0]!.attrs.href).toBe(absolute(fixture.verifiedProfile));
  });
  test('published-vertical-metadata: configured alternate public origin is canonical', async () => {
    await driver.configurePublicOrigin(data.alternatePublicOrigin);
    const response = await driver.request(fixture.subjects.book, 'anonymous', { host: 'untrusted-host.invalid' });
    expect(response.status).toBe(200);
    const html = await response.text();
    const expected = new URL(new URL(absolute(fixture.subjects.book)).pathname, data.alternatePublicOrigin).href;
    expect((await elements(html, 'link[rel="canonical"]'))[0]!.attrs.href).toBe(expected);
    expect((await elements(html, 'meta[property="og:url"]'))[0]!.attrs.content).toBe(expected);
    const graph = (await elements(html, 'script[type="application/ld+json"]'))[0]!.content;
    expect(graph).toContain(data.alternatePublicOrigin);
    expect(graph).not.toContain(fixture.publicOrigin);
    expect(html).not.toContain('untrusted-host.invalid');
  });
});

async function xml(url: string) {
  const response = await driver.request(url);
  expect(response.status).toBe(200);
  const bytes = new Uint8Array(await response.arrayBuffer());
  // HTTP may already have decoded Content-Encoding; gzip sitemap objects may
  // instead be served as application/gzip. Inspect bytes, never rewrite Response.
  return new TextDecoder().decode(bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes);
}
const xmlValues = (source: string, tag: string) =>
  [...source.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'g'))].map((v) => decode(v[1]!.trim()));
function validTime(value: string) {
  expect(value).toMatch(/^\d{4}-\d{2}-\d{2}(?:T.*Z)?$/);
  expect(Number.isFinite(Date.parse(value))).toBe(true);
}

describe('public-discovery-and-cache', () => {
  test('public-discovery-and-cache: robots and every sitemap shard publish exactly eligible native feed URLs', async () => {
    const robots = await driver.request('/robots.txt');
    expect(robots.status).toBe(200);
    const rules = await robots.text();
    expect(rules).toContain(`Sitemap: ${fixture.publicOrigin}/sitemap.xml`);
    expect(rules).toMatch(/Disallow:.*\/api/);
    expect(rules).toMatch(/Disallow:.*library/);
    const index = await xml('/sitemap.xml');
    expect(index).toContain('<sitemapindex');
    const shards = xmlValues(index, 'sitemap');
    expect(shards.length).toBeGreaterThanOrEqual(data.discovery.kinds.length);
    const shardUrls: string[] = [];
    const actual = new Map<string, string | null>();
    for (const shard of shards) {
      const locations = xmlValues(shard, 'loc');
      expect(locations.length).toBe(1);
      const location = locations[0]!;
      expect(location).toMatch(/\/sitemap-[^/]+-[^/]+\.xml\.gz$/);
      expect(new URL(location).origin).toBe(fixture.publicOrigin);
      expect(shardUrls).not.toContain(location);
      shardUrls.push(location);
      const changed = xmlValues(shard, 'lastmod');
      expect(changed.length).toBe(1);
      validTime(changed[0]!);
      const source = await xml(location);
      expect(source).toContain('<urlset');
      const entries = xmlValues(source, 'url');
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        const urls = xmlValues(entry, 'loc');
        expect(urls.length).toBe(1);
        const url = urls[0]!;
        expect(actual.has(url)).toBe(false);
        const times = xmlValues(entry, 'lastmod');
        expect(times.length).toBeLessThanOrEqual(1);
        if (times[0]) validTime(times[0]);
        actual.set(url, times[0] ?? null);
        const alternates = await elements(entry, 'xhtml\\:link');
        expect(alternates.map((a) => a.attrs.hreflang).sort()).toEqual([...data.locales].sort());
        expect(alternates.some((a) => a.attrs.href === url)).toBe(true);
        expect(entry).not.toMatch(/<(?:priority|changefreq)\b/);
      }
    }
    const expected = new Map<string, string | null>();
    for (const kind of data.discovery.kinds as SitemapKind[]) {
      const inventory = fixture.sitemap[kind];
      expect(inventory.eligible.length).toBeGreaterThanOrEqual(data.discovery.eligiblePerKind * data.locales.length);
      expect(inventory.excluded.length).toBeGreaterThanOrEqual(data.discovery.controlsPerKind[kind].length);
      for (const item of inventory.eligible) {
        expect(expected.has(item.url)).toBe(false);
        expected.set(item.url, item.lastmod);
        expect(actual.get(item.url)).toBe(item.lastmod);
      }
      for (const url of inventory.excluded) expect(actual.has(url)).toBe(false);
    }
    expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());
  });
  test('public-discovery-and-cache: Alice warming a public page cannot leak personal facts to anonymous or Bob', async () => {
    const warmed = await document(fixture.publicPage, 'alice');
    expect(warmed.response.headers.get('cache-control')).toMatch(/public|s-maxage/);
    expect(warmed.response.headers.get('etag')).toBeTruthy();
    for (const persona of ['alice', 'anonymous', 'bob'] as const) {
      const page = persona === 'alice' ? warmed : await document(fixture.publicPage, persona);
      for (const value of [...Object.values(data.personal), ...data.withheld])
        expect(decode(page.html)).not.toContain(value);
      expect(page.visible).toBe(warmed.visible);
      expect((await elements(page.html, 'script[type="application/ld+json"]')).map((v) => v.content)).toEqual(
        (await elements(warmed.html, 'script[type="application/ld+json"]')).map((v) => v.content),
      );
    }
  });
  test('public-discovery-and-cache: private hydration requires Alice current authority', async () => {
    const own = await driver.request(fixture.personalRead, 'alice');
    expect(own.status).toBe(200);
    const body = decode(await own.text());
    for (const value of Object.values(data.personal)) expect(body).toContain(value);
    expect(own.headers.get('cache-control')).toContain('no-store');
    for (const persona of ['anonymous', 'bob'] as const) {
      const denied = await driver.request(fixture.personalRead, persona);
      expect([401, 403, 404]).toContain(denied.status);
      const body = await denied.text();
      for (const value of Object.values(data.personal)) expect(body).not.toContain(value);
    }
    const banned = await driver.request(fixture.bannedRead, 'alice');
    expect([403, 404]).toContain(banned.status);
    expect(await banned.text()).not.toContain(data.withheld[2]!);
    await driver.revokeAlice();
    const denied = await driver.request(fixture.personalRead, 'alice');
    expect([401, 403, 404]).toContain(denied.status);
    const revoked = await denied.text();
    for (const value of Object.values(data.personal)) expect(revoked).not.toContain(value);
  });
});

describe('page-states', () => {
  test('page-states: preparing subject view is useful retryable and does not cache an error', async () => {
    const restore = await driver.interrupt('subject-view');
    try {
      const response = await driver.request(fixture.preparingView);
      expect(response.status).toBe(202);
      expect(response.headers.get('content-type')).toContain('text/html');
      expect(response.headers.get('cache-control')).toContain('no-store');
      expect(response.headers.get('retry-after')).toBeTruthy();
      const html = await response.text();
      const main = (await elements(html, 'main'))[0]!.content;
      expect(main).toContain(data.states.preparing);
      expect(main).toContain(data.states.retry);
      expect((await links(html)).length).toBeGreaterThan(0);
    } finally {
      await restore();
    }
    await driver.settle();
    const ready = await document(fixture.preparingView);
    expect(ready.visible).not.toContain(data.states.preparing);
    expect((await links(ready.html)).length).toBeGreaterThan(0);
  });
  test('page-states: unavailable owner read serves an unavailable page with Retry-After', async () => {
    const restore = await driver.interrupt('owner-read');
    try {
      const page = await document(fixture.unavailableView, 'anonymous', 503);
      expect(page.visible).toContain(data.states.unavailable);
      expect(page.visible).toContain(data.states.retry);
      expect(page.response.headers.get('retry-after')).toBeTruthy();
      expect(page.response.headers.get('cache-control')).toContain('no-store');
    } finally {
      await restore();
    }
  });
  test('page-states: private Collection is indistinguishable from missing to anonymous', async () => {
    const hidden = await document(fixture.privateCollection, 'anonymous', 404);
    const missing = await document(fixture.unknownCollection, 'anonymous', 404);
    expect(hidden.visible).toBe(missing.visible);
    expect(hidden.html).not.toContain('Alice Label Sentinel');
  });
  test('page-states: empty public list explicitly says it is empty', async () => {
    const page = await document(fixture.emptyPublicList);
    expect(page.visible).toContain(data.states.empty);
    expect(page.visible).not.toContain(data.states.unavailable);
    expect(page.visible).not.toContain(data.states.preparing);
  });
  test('page-states: native suspended persona personal read is 401 invalid_credentials with invalid_token challenge and no personal content', async () => {
    const response = await driver.request(fixture.personalRead, 'suspended');
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    expect(response.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ status: 401, code: 'invalid_credentials' });
    for (const value of Object.values(data.personal)) expect(body).not.toContain(value);
  });
});

describe('search-page', () => {
  test('search-page: anonymous zh-Hans Book search renders native order localized unique facets and no engine totals', async () => {
    const native = await driver.nativeSearch();
    expect(native.results.status).toBe(200);
    expect(native.facets.status).toBe(200);
    const result = await native.results.json();
    const facets = await native.facets.json();
    expect(result.subjects.length).toBe(data.search.matchingBooks.length);
    const page = await document(fixture.searchZhHans);
    expect((await elements(page.html, 'html'))[0]!.attrs.lang).toBe(data.search.locale);
    const targets = result.subjects.map((subject: { id: string }) => subject.id);
    const resultLinks = (await links(page.html)).filter((a) =>
      targets.some((id: string) => new URL(a.href).pathname.includes(`/subjects/${id}/`)),
    );
    expect(
      resultLinks.map((a) => targets.find((id: string) => new URL(a.href).pathname.includes(`/subjects/${id}/`))),
    ).toEqual(targets);
    expect(resultLinks.map((a) => a.label).sort()).toEqual([...data.search.matchingBooks].sort());
    expect(facets.facets.length).toBeGreaterThan(0);
    for (const label of data.search.facetLabels) {
      expect(JSON.stringify(facets)).toContain(label);
      expect(page.visible.split(label).length - 1).toBe(1);
    }
    for (const label of data.search.forbiddenFallbackLabels) expect(page.visible).not.toContain(label);
    expect(page.visible).not.toMatch(/(?:\d[\d,]*\s+(?:results|matches)\b|共\s*\d+\s*(?:条|项)|engine.?total)/i);
    expect(page.html).not.toMatch(/"(?:total|totalHits|total_hits|engineTotal|engine_total)"\s*:/);
  });
});
