import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import data from '../../../../specs/fixtures/web-publication.json';
import type { WebPublicationDriver } from '../../../../specs/web-publication-driver';

setDefaultTimeout(600_000);
let driver: WebPublicationDriver;
let fixture: Awaited<ReturnType<WebPublicationDriver['provision']>>;
beforeAll(async () => {
  const binding = await import('./web-publication-driver.ts');
  driver = await binding.createWebPublicationDriver();
  fixture = await driver.provision(data);
  await driver.settle();
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
    }
  });

  test('provision writes fixture facts through kernel APIs under the released definitions', async () => {
    expect(fixture.releaseDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Object.keys(fixture.subjects)).toEqual(expect.arrayContaining(Object.keys(data.subjects)));
    for (const url of [...Object.values(fixture.subjects), ...Object.values(fixture.views)]) {
      expect(new URL(url).origin).toBe(fixture.publicOrigin);
    }
    expect(fixture.publicOrigin).toBe('https://rezics.example.test');
  });

  test('settle drains durable publication, search and sitemap feed continuations to completion', async () => {
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
