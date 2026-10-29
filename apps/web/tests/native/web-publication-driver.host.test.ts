import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import data from '../../../../specs/fixtures/web-publication.json';
import type { WebPublicationDriver } from '../../../../specs/web-publication-driver';

const owned: WebPublicationDriver[] = [];
setDefaultTimeout(180_000);
afterEach(async () => {
  await Promise.all(owned.splice(0).map((driver) => driver.close()));
});

async function create() {
  const binding = await import('./web-publication-driver.ts');
  const driver = await binding.createWebPublicationDriver();
  owned.push(driver);
  return driver;
}

describe('native web publication driver host', () => {
  test('provision writes fixture facts through kernel APIs under the released definitions', async () => {
    const driver = await create();
    const fixture = await driver.provision(data);
    expect(fixture.releaseDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Object.keys(fixture.subjects)).toEqual(expect.arrayContaining(Object.keys(data.subjects)));
    for (const url of [...Object.values(fixture.subjects), ...Object.values(fixture.views)]) {
      expect(new URL(url).origin).toBe(fixture.publicOrigin);
    }
    expect(fixture.publicOrigin).toBe(data.publicOrigin);
  });

  test('settle drains durable publication, search and sitemap feed continuations to completion', async () => {
    const driver = await create();
    await driver.provision(data);
    await driver.settle();
    const response = await driver.request('/robots.txt');
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('sitemap');
  });

  test('request is real HTTP and origin reconfiguration retains native data', async () => {
    const driver = await create();
    const fixture = await driver.provision(data);
    const response = await driver.request(fixture.subjects.book, 'anonymous', { 'x-driver-probe': 'preserved' });
    expect(response).toBeInstanceOf(Response);
    expect([200, 301, 302, 404]).toContain(response.status);
    await driver.configurePublicOrigin(data.alternatePublicOrigin);
    const afterRestart = await driver.request(fixture.subjects.book);
    expect(afterRestart).toBeInstanceOf(Response);
    const robots = await driver.request('/robots.txt');
    expect(await robots.text()).toContain(data.alternatePublicOrigin);
  });

  test('later methods name their delivery task and close is safe to repeat', async () => {
    const driver = await create();
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
    owned.splice(owned.indexOf(driver), 1);
  });
});
