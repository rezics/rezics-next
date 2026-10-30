import { afterAll, describe, expect, setDefaultTimeout } from 'bun:test';
import data from '../../../../specs/fixtures/web-publication.json';
import type { WebPublicationDriver } from '../../../../specs/web-publication-driver';
import { bundledRelease } from '@rezics/definitions/bundled';
import { NativeTestLifecycle, nativeAfterAll, nativeBeforeAll, nativeTest } from './lifecycle.ts';

setDefaultTimeout(600_000);
let driver: WebPublicationDriver;
let fixture: Awaited<ReturnType<WebPublicationDriver['provision']>>;
const lifecycle = new NativeTestLifecycle('native web publication driver suite');
nativeBeforeAll(lifecycle, 600_000, async () => {
  const binding = await import('./web-publication-driver.ts');
  driver = await binding.createWebPublicationDriver(600_000);
  fixture = await driver.provision(data);
});
afterAll(async () => driver?.close());
nativeAfterAll(lifecycle, 600_000);

describe('native web publication driver host', () => {
  nativeTest(
    'fixture subjects retain their native released types independently of page Schema.org classes',
    600_000,
    async () => {
      const expectedTypes = {
        book: 'schema:Book',
        recipe: 'schema:Recipe',
        game: 'schema:VideoGame',
        release: 'wd:Q20631656',
        person: 'schema:Person',
        organization: 'schema:Organization',
        automated: 'schema:SoftwareApplication',
      };
      const kernelOrigin = new URL(fixture.personalRead).origin;
      for (const [key, type] of Object.entries(expectedTypes)) {
        const id = new URL(fixture.subjects[key]!).pathname.split('/')[3]!;
        const response = await fetch(`${kernelOrigin}/v1/subjects/${encodeURIComponent(id)}`, { redirect: 'manual' });
        expect(response.status).toBe(200);
        const body = (await response.json()) as { subject: { id: string; type: string } };
        expect(body.subject.id).toBe(id);
        expect(body.subject.type).toBe(type);
        expect(bundledRelease.types[type]?.schemaOrgType).toBe(
          `https://schema.org/${data.subjects[key as keyof typeof data.subjects].schemaOrgType}`,
        );
      }
    },
    lifecycle,
  );

  nativeTest(
    'provision writes fixture facts through kernel APIs under the released definitions',
    600_000,
    async () => {
      expect(fixture.releaseDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(Object.keys(fixture.subjects)).toEqual(expect.arrayContaining(Object.keys(data.subjects)));
      for (const url of [...Object.values(fixture.subjects), ...Object.values(fixture.views)]) {
        expect(new URL(url).origin).toBe(fixture.publicOrigin);
      }
      expect(fixture.publicOrigin).toBe('https://rezics.example.test');
      const unsupported = structuredClone(data);
      unsupported.subjects.book.type = 'schema:MissingPublicationType';
      await expect(driver.provision(unsupported)).rejects.toThrow('schema:MissingPublicationType');
    },
    lifecycle,
  );

  nativeTest(
    'the subject sitemap export lists every fixture subject',
    600_000,
    async () => {
      const kernelOrigin = new URL(fixture.personalRead).origin;
      const published = new Set<string>();
      let cursor: string | null = null;
      do {
        const query = new URLSearchParams({ limit: '100' });
        if (cursor !== null) query.set('cursor', cursor);
        const pageResponse = await fetch(`${kernelOrigin}/v1/subject-pages?${query}`, { redirect: 'manual' });
        expect(pageResponse.status).toBe(200);
        const page = (await pageResponse.json()) as { subjectPages: { id: string }[]; next: string | null };
        for (const subject of page.subjectPages) published.add(subject.id);
        cursor = page.next;
      } while (cursor !== null);
      for (const url of Object.values(fixture.subjects))
        expect(published.has(new URL(url).pathname.split('/')[3]!)).toBe(true);
    },
    lifecycle,
  );

  nativeTest(
    "settle waits until the fixture's built feeds show it",
    600_000,
    async () => {
      await driver.settle();
      const kernelOrigin = new URL(fixture.personalRead).origin;
      for (const kind of ['collection', 'realm', 'space', 'board', 'thread'] as const) {
        const published = new Set<string>();
        let cursor: string | null = null;
        do {
          const query = new URLSearchParams({ limit: '100' });
          if (cursor !== null) query.set('cursor', cursor);
          const response = await fetch(`${kernelOrigin}/v1/sitemap/${kind}s?${query}`, { redirect: 'manual' });
          expect(response.status).toBe(200);
          const page = (await response.json()) as { items: { id: string }[]; next: string | null };
          page.items.forEach(({ id }) => published.add(id));
          cursor = page.next;
        } while (cursor !== null);
        for (const { url } of fixture.sitemap[kind].eligible)
          expect(published.has(new URL(url).pathname.split('/')[3]!)).toBe(true);
      }
      const response = await driver.request('/robots.txt');
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('sitemap');
    },
    lifecycle,
  );

  nativeTest(
    "native search returns the fixture's matching books",
    600_000,
    async () => {
      const kernelOrigin = new URL(fixture.personalRead).origin;
      const search = await fetch(`${kernelOrigin}/v1/subjects:search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: data.search.query, languages: [data.search.locale], limit: 100 }),
        redirect: 'manual',
      });
      expect(search.status).toBe(200);
      const results = (await search.json()) as { subjects: { labels: Record<string, string> }[] };
      expect(results.subjects.map((subject) => subject.labels[data.search.locale])).toEqual(
        expect.arrayContaining(data.search.matchingBooks),
      );
    },
    lifecycle,
  );

  nativeTest(
    'request is real HTTP and origin reconfiguration retains native data',
    600_000,
    async () => {
      const response = await driver.request('/robots.txt', 'anonymous', { 'x-driver-probe': 'preserved' });
      expect(response).toBeInstanceOf(Response);
      expect(response.status).toBe(200);
      // Record the native request cost even while publication/search owners are
      // still delivering these served surfaces. Their outcome cases stay separate.
      const searchPage = await driver.request(fixture.searchZhHans);
      console.info(`web-publication-driver-growth: search-page-status=${searchPage.status}`);
      await searchPage.body?.cancel();
      const sitemapIndex = await driver.request('/sitemap.xml');
      const sitemapBody = await sitemapIndex.text();
      const shard = sitemapIndex.ok ? /<loc>([^<]+)<\/loc>/.exec(sitemapBody)?.[1] : undefined;
      if (shard) {
        const sitemapShard = await driver.request(shard);
        console.info(`web-publication-driver-growth: sitemap-shard-status=${sitemapShard.status}`);
        await sitemapShard.body?.cancel();
      } else {
        console.info(`web-publication-driver-growth: sitemap-shard-unavailable index-status=${sitemapIndex.status}`);
      }
      await driver.configurePublicOrigin(data.alternatePublicOrigin);
      const afterRestart = await driver.request(fixture.subjects.book, 'anonymous', { host: 'untrusted.invalid' });
      expect(afterRestart).toBeInstanceOf(Response);
      if (afterRestart.status === 403) throw new Error(`Foreign Host returned 403: ${await afterRestart.text()}`);
      expect(afterRestart.status).toBe(200);
    },
    lifecycle,
  );

  nativeTest(
    'later methods name their delivery task and close is safe to repeat',
    600_000,
    async () => {
      for (const [method, call] of [
        ['interrupt', () => driver.interrupt('owner-read')],
        ['revokeAlice', () => driver.revokeAlice()],
        ['proposeCompetingDate', () => driver.proposeCompetingDate()],
        ['nativeSearch', () => driver.nativeSearch()],
      ] as const) {
        await expect(call()).rejects.toThrow(method);
      }
      await driver.close();
      await expect(driver.close()).resolves.toBeUndefined();
    },
    lifecycle,
  );
});
