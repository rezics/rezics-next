import { afterEach, beforeEach, expect, test } from 'bun:test';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { LibraryTypePreparationDriver } from './library-type-preparation-driver.ts';
let driver: LibraryTypePreparationDriver;
beforeEach(async () => {
  const location = process.env.LIBRARY_TYPE_PREPARATION_DRIVER;
  if (!location) throw new Error('Library type preparation outcome driver is required');
  if (!isAbsolute(location) && !location.startsWith('file:')) throw new Error('Expected an absolute driver path');
  const url = isAbsolute(location) ? pathToFileURL(location) : new URL(location);
  if (url.protocol !== 'file:') throw new Error('Expected a file driver');
  driver = await (await import(url.href)).createLibraryTypePreparationDriver();
});
afterEach(async () => {
  const current = driver;
  driver = undefined!;
  await current?.close();
});
test('native continuation verifies identity without retransferring staged source text', async () => {
  const text = 'schema:' + 'A'.repeat(256 * 405),
    f = await driver.fixture({ type: text, digest: 'constant', requestBudgetMs: 3000 });
  await driver.primeType(f, 'schema:Primary');
  const response = await driver.request(
    f,
    'PUT',
    `/v1/libraryEntries/${f.subjectId}`,
    { state: 'planned' },
    f.requestKey,
  );
  expect(response.status).toBe(503);
  const before = await driver.inspect(f);
  expect(before.reservations).toHaveLength(1);
  const preparationId = before.evidence[0]!.preparationId;
  await driver.advanceUnrelatedSource(f);
  await driver.settleMetadata();
  const after = await driver.inspect(f);
  expect(after.ready.some((x) => x.evidence.preparationId === preparationId)).toBe(true);
  expect(after.effects).toEqual(before.effects);
  const checks = after.sourceReads.filter((x) => x.phase === 'page' || x.phase === 'publication');
  expect(checks.length).toBeGreaterThan(1);
  for (const check of checks) {
    expect(check.identityClient).toBe(check.partitionClient);
    expect(check.typeClient).toBeNull();
    expect(check.typeBytes).toBe(0);
  }
  const retry = await driver.request(f, 'PUT', `/v1/libraryEntries/${f.subjectId}`, { state: 'planned' }, f.requestKey);
  expect(retry.status).toBe(201);
  expect(await driver.lookup(f, text)).not.toBeNull();
}, 240000);
