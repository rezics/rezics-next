import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createCoverageStore } from '../../src/search/coverage-store.ts';
import { initializeSubjectIncarnation } from '../../src/search/coverage.ts';
import { documentActions } from '../../src/search/document.ts';
import { createSubjectIndex, subjectIndexName } from '../../src/search/indices.ts';
import { OpenSearchError } from '../../src/search/opensearch.ts';
import { subjectConsumer } from '../../src/search/runner.ts';
import { subjectPartition } from '../../src/search/source.ts';
import { createCoverageFixture } from './coverage-fixture.ts';

// Independent initializer acceptance: no coordinator, native readiness, activation or certificate setup.
let f: Awaited<ReturnType<typeof createCoverageFixture>>;
beforeAll(async () => {
  f = await createCoverageFixture();
}, 180_000);
afterAll(async () => {
  await f?.close();
}, 180_000);

async function uuid(index: string) {
  const result = await f.search.request<Record<string, { settings: { index: { uuid: string } } }>>(
    'GET',
    `/${index}/_settings`,
  );
  return result.body[index]!.settings.index.uuid;
}

test('physical coverage lineage', async () => {
  const prefix = f.fresh();
  const config = f.options(prefix);
  const store = createCoverageStore(f.pool);
  expect(await store.readPrefix(prefix)).toBeNull();
  await expect(f.search.request('HEAD', `/${subjectIndexName(prefix, 1)}`)).rejects.toMatchObject({ status: 404 });
  const target = await initializeSubjectIncarnation(config, 1);
  expect(target).toEqual({
    prefix,
    generation: 1,
    index: subjectIndexName(prefix, 1),
    uuid: await uuid(subjectIndexName(prefix, 1)),
    protocol: 'subject-coverage-v1',
    consumer: subjectConsumer(prefix, 1),
  });
  expect(target.uuid.length).toBeGreaterThan(0);
  expect((await f.search.request<{ count: number }>('GET', `/${target.index}/_count`)).body.count).toBe(0);
  expect(await store.readPrefix(prefix)).toMatchObject({ prefix, issuedGeneration: 1 });
  expect(await store.readLineage(target)).toEqual({
    incarnation: target,
    revision: 1n,
    state: 'populating',
    origin: 'created-empty',
    partition: 0,
    after: null,
    complete: false,
  });
  const restarted = createCoverageStore(f.pool);
  expect(await restarted.readLineage(target)).toEqual(await store.readLineage(target));
}, 180_000);

test('existing empty unbound and recreated physical identities cannot become known-empty', async () => {
  const prefix = f.fresh();
  await createSubjectIndex(f.search, prefix, 1);
  const original = await uuid(subjectIndexName(prefix, 1));
  await expect(initializeSubjectIncarnation(f.options(prefix), 1)).rejects.toMatchObject({ code: 'index_not_ready' });
  expect(await uuid(subjectIndexName(prefix, 1))).toBe(original);
  await f.search.request('DELETE', `/${subjectIndexName(prefix, 1)}`);
  await createSubjectIndex(f.search, prefix, 1);
  expect(await uuid(subjectIndexName(prefix, 1))).not.toBe(original);
  await expect(initializeSubjectIncarnation(f.options(prefix), 1)).rejects.toMatchObject({ code: 'index_not_ready' });
  const controlled = f.fresh();
  const target = await initializeSubjectIncarnation(f.options(controlled), 1);
  await f.search.request('DELETE', `/${target.index}`);
  await expect(initializeSubjectIncarnation(f.options(controlled), 1)).rejects.toMatchObject({
    code: 'index_not_ready',
  });
}, 180_000);

test('cluster actually rejects implicit creation of a deleted controlled subject target', async () => {
  const target = await initializeSubjectIncarnation(f.options(f.fresh()), 1);
  const [id] = await f.books(1);
  const snapshot = await f.source.read(subjectPartition(id), [id]);
  const action = documentActions(snapshot, [id])[0]!;
  expect(action.op).toBe('index');
  if (action.op !== 'index') throw new Error('Real source did not produce a live baseline document');
  await f.search.request('DELETE', `/${target.index}`);
  // An intentionally uncertified wrong-key probe, using the real source body. No cluster setting is changed.
  let rejected = false;
  try {
    await f.search.request('PUT', `/${target.index}/_doc/${crypto.randomUUID()}`, action.document);
  } catch (error) {
    if (!(error instanceof OpenSearchError)) throw error;
    expect(error.status).toBe(404);
    expect(error.type).toBe('index_not_found_exception');
    rejected = true;
  }
  expect(rejected, 'The engine must enforce implicit-creation denial, not merely advertise a setting').toBe(true);
  await expect(f.search.request('HEAD', `/${target.index}`)).rejects.toMatchObject({ status: 404 });
}, 180_000);
