import { afterAll, beforeAll, expect, test } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool } from 'pg';
import { createPool } from '../../src/database/pool.ts';
import {
  createReleasedDiscoveryFixture,
  discoveryStatement,
  type ReleasedDiscoveryFixture,
} from '../support/released-discovery.ts';

const capture = new AsyncLocalStorage<string>();
const pools: { url: string; pool: Pool; ends: number }[] = [];
const statements: { pool: number; context: string | undefined; text: string }[] = [];
let fixture: ReleasedDiscoveryFixture;

beforeAll(async () => {
  fixture = await createReleasedDiscoveryFixture({
    version: 1,
    search: 'native',
    async kernelPool(url) {
      const pool = createPool(url);
      const index = pools.length;
      const owned = { url, pool, ends: 0 };
      pools.push(owned);
      const end = pool.end.bind(pool);
      pool.end = (() => {
        owned.ends += 1;
        return end();
      }) as Pool['end'];
      pool.on('connect', (client) => {
        const query = client.query;
        client.query = function (this: typeof client, ...args: unknown[]) {
          const statement = args[0];
          const text = typeof statement === 'string' ? statement : (statement as { text?: string } | undefined)?.text;
          if (text) statements.push({ pool: index, context: capture.getStore(), text });
          return Reflect.apply(query, this, args);
        } as typeof query;
      });
      return pool;
    },
  });
}, 120_000);

afterAll(async () => {
  if (fixture) {
    const closing = fixture.close();
    expect(fixture.close()).toBe(closing);
    await closing;
  }
  for (const owned of pools) {
    expect(owned.ends).toBe(1);
    expect(owned.pool.ended).toBe(true);
  }
}, 180_000);

async function visibleInSuggest(id: string, query: string) {
  const result = await fixture.request('anonymous', 'GET', `/v1/subjects:suggest?q=${encodeURIComponent(query)}`);
  expect(result.status).toBe(200);
  expect(result.body.subjects).toEqual(expect.arrayContaining([expect.objectContaining({ id })]));
}

test('shared released discovery records converge through the actual default Search worker and production HTTP using one owned native database', async () => {
  const name = `Sharedbinding${crypto.randomUUID().replaceAll('-', '')}`;
  const book = await fixture.createSubject('schema:Book', name);
  expect(book.release).toBe(fixture.release.digest);
  await fixture.search!.converge([book]);
  await visibleInSuggest(book.id, name);

  await fixture.search!.indexing('paused');
  const editionName = `Sharededition${crypto.randomUUID().replaceAll('-', '')}`;
  const edition = await fixture.createSubject('bf:Instance', editionName);
  const fact = await fixture.adopt(edition, discoveryStatement('schema:exampleOfWork', book.id));
  const deadline = Date.now() + 15_000;
  for (;;) {
    const links = await fixture.request('anonymous', 'GET', `/v1/subjects/${book.id}/links`);
    expect(links.status).toBe(200);
    if (
      (links.body.links as { subject: string; statement: string }[]).some(
        (link) => link.subject === edition.id && link.statement === fact.candidate,
      )
    )
      break;
    if (Date.now() >= deadline)
      throw new Error(
        `Default worker link relay did not progress while Search was paused: ${JSON.stringify(links.body)}`,
      );
    await Bun.sleep(25);
  }
  const paused = await fixture.request('anonymous', 'POST', '/v1/subjects:search', { text: editionName });
  expect(paused.status).toBe(200);
  expect(paused.body.subjects).toEqual([]);
  await fixture.search!.indexing('running');
  await fixture.search!.converge([book, edition]);
  await visibleInSuggest(edition.id, editionName);
}, 60_000);

test('shared native runtime pools remain observable through the provided kernelPool factory', async () => {
  expect(pools).toHaveLength(2);
  const urls = new Set(pools.map(({ url }) => url));
  expect(urls.size).toBe(1);
  expect(pools[0]!.url).not.toBe(process.env.DATABASE_URL);
  expect(new URL(pools[0]!.url).pathname).toMatch(/^\/semantic_[a-f0-9]+$/);

  await fixture.search!.indexing('paused');
  await capture.run('native-requests-and-worker', async () => {
    const name = `Captured${crypto.randomUUID().replaceAll('-', '')}`;
    const subject = await fixture.createSubject('schema:Book', name);
    await fixture.search!.indexing('running');
    await fixture.search!.converge([subject]);
    await visibleInSuggest(subject.id, name);
    await fixture.search!.indexing('paused');
  });
  const actual = statements.filter((entry) => entry.context === 'native-requests-and-worker');
  expect(actual.some((entry) => entry.pool === 0 && /semantic\./.test(entry.text))).toBe(true);
  expect(actual.some((entry) => entry.pool === 1 && /semantic\./.test(entry.text))).toBe(true);
  expect(actual.some((entry) => entry.pool === 1 && /consumer_checkpoint/.test(entry.text))).toBe(true);
  await fixture.search!.indexing('running');
}, 60_000);
