import { afterEach, expect, test } from 'bun:test';
import data from '../../../../specs/fixtures/web-publication.json';
import type { WebPublicationDriver } from '../../../../specs/web-publication-driver';

let driver: WebPublicationDriver | undefined;
afterEach(async () => {
  await driver?.close();
  driver = undefined;
});

test('publication driver provisions through kernel APIs and controls native publication', async () => {
  const binding = await import('./web-publication-driver.ts');
  driver = await binding.createWebPublicationDriver();
  const fixture = await driver.provision(data);
  expect(fixture.releaseDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(Object.keys(fixture.subjects)).toContain('book');
  expect(new URL(fixture.subjects.book).origin).toBe(fixture.publicOrigin);
  await driver.settle();
  const savedSession = await driver.kernel('/v1/sessions', { method: 'GET' }, 'alice');
  expect(savedSession.status).toBe(200);
  await driver.revokeAlice();
  const sameSession = await driver.kernel('/v1/sessions', { method: 'GET' }, 'alice');
  expect(sameSession.status).toBe(200);

  const restoreProjection = await driver.interrupt('subject-view');
  await restoreProjection();
  await restoreProjection();
  const restoreOwner = await driver.interrupt('owner-read');
  await restoreOwner();
  await driver.configurePublicOrigin(data.alternatePublicOrigin);
  const native = await driver.nativeSearch();
  expect(native.results).toBeInstanceOf(Response);
  expect(native.facets).toBeInstanceOf(Response);
});
