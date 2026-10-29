import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import data from '../../../../specs/fixtures/web-publication.json';
import type { WebPublicationDriver } from '../../../../specs/web-publication-driver';
import { bundledRelease } from '@rezics/definitions/bundled';

setDefaultTimeout(600_000);
let driver: WebPublicationDriver;
let fixture: Awaited<ReturnType<WebPublicationDriver['provision']>>;
beforeAll(async () => {
  const binding = await import('./web-publication-driver.ts');
  driver = await binding.createWebPublicationDriver();
  fixture = await driver.provision(data);
});
afterAll(async () => driver?.close());

describe('native web publication driver host', () => {
  test('fixture subjects retain their native released types independently of page Schema.org classes', async () => {
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
  });

  test('provision writes fixture facts through kernel APIs under the released definitions', async () => {
    expect(fixture.releaseDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Object.keys(fixture.subjects)).toEqual(expect.arrayContaining(Object.keys(data.subjects)));
    for (const url of [...Object.values(fixture.subjects), ...Object.values(fixture.views)]) {
      expect(new URL(url).origin).toBe(fixture.publicOrigin);
    }
    expect(fixture.publicOrigin).toBe('https://rezics.example.test');
    const unsupported = structuredClone(data);
    unsupported.subjects.book.type = 'schema:MissingPublicationType';
    await expect(driver.provision(unsupported)).rejects.toThrow('schema:MissingPublicationType');
  });

  test('settle drains durable publication, search and sitemap feed continuations to completion', async () => {
    await driver.settle();
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
    const response = await driver.request('/robots.txt');
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('sitemap');
  });

  test('request is real HTTP and origin reconfiguration retains native data', async () => {
    const response = await driver.request('/robots.txt', 'anonymous', { 'x-driver-probe': 'preserved' });
    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(200);
    await driver.configurePublicOrigin(data.alternatePublicOrigin);
    const afterRestart = await driver.request(fixture.subjects.book, 'anonymous', { host: 'untrusted.invalid' });
    expect(afterRestart).toBeInstanceOf(Response);
    expect(afterRestart.status).toBe(200);
  });

  test('later methods name their delivery task and close is safe to repeat', async () => {
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
  });
});
