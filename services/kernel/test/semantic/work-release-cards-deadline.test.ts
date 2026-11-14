import { afterAll, expect, test } from 'bun:test';
import type { Pool, PoolClient, QueryConfig } from 'pg';
import { createPool } from '../../src/database/pool.ts';
import { readNativeWorkReleaseCards } from '../../src/semantic/work-release-cards.ts';
import type { WorkReleaseCardMembershipLink } from '../../src/semantic/copy-work-reader-port.ts';
import {
  createReleasedDiscoveryFixture,
  discoveryStatement,
  type ReleasedDiscoveryFixture,
} from '../support/released-discovery.ts';

let kernelPool: Pool | undefined;
let observeSelectedFieldQueries = false;
let selectedFieldQueryCount = 0;
let postSlowFieldQueryCount = 0;
let slowFieldClient: PoolClient | undefined;
let slowFieldReleaseError: Error | undefined;
let completeSlowFieldQuery: (() => void) | undefined;
let slowFieldQuerySettled: Promise<void> | undefined;

const fixturePromise = createReleasedDiscoveryFixture({
  version: 1,
  kernelPool(url) {
    const pool = createPool(url);
    kernelPool = pool;
    const connect = pool.connect.bind(pool);
    (pool as Pool & { connect: Pool['connect'] }).connect = (async () => {
      const client = await connect();
      const query = client.query.bind(client);
      const release = client.release.bind(client);
      let released = false;

      client.query = ((input: QueryConfig | string, values?: unknown[]) => {
        const text = typeof input === 'string' ? input : input.text;
        if (observeSelectedFieldQueries && slowFieldClient) postSlowFieldQueryCount += 1;
        if (observeSelectedFieldQueries && text.includes('SELECT * FROM semantic.fact')) {
          selectedFieldQueryCount += 1;
          if (selectedFieldQueryCount === 1) {
            slowFieldClient = client;
            return new Promise((resolve, reject) => {
              setTimeout(() => {
                if (released) {
                  completeSlowFieldQuery?.();
                  reject(new Error('A retired card snapshot cannot dispatch its field query'));
                  return;
                }
                Reflect.apply(query, client, [input, values]).then(
                  (result) => {
                    completeSlowFieldQuery?.();
                    resolve(result);
                  },
                  (error: unknown) => {
                    completeSlowFieldQuery?.();
                    reject(error);
                  },
                );
              }, 1_200);
            }) as unknown as ReturnType<PoolClient['query']>;
          }
        }
        return Reflect.apply(query, client, [input, values]) as ReturnType<PoolClient['query']>;
      }) as PoolClient['query'];

      client.release = ((error?: Error) => {
        if (client === slowFieldClient) {
          released = true;
          slowFieldReleaseError = error;
        }
        return Reflect.apply(release, client, [error]);
      }) as PoolClient['release'];
      return client;
    }) as Pool['connect'];
    return pool;
  },
});
let fixture: ReleasedDiscoveryFixture;

afterAll(async () => {
  fixture ??= await fixturePromise;
  await fixture.close();
});

test('release cards stop selected-field work at their original explicit deadline', async () => {
  fixture = await fixturePromise;
  const work = await fixture.createSubject('schema:Book', 'Deadline-bound book work');
  const edition = await fixture.createSubject('bf:Instance', 'Deadline-bound book edition');
  const publisher = await fixture.createSubject('schema:Organization', 'Deadline-bound publisher');
  await fixture.adopt(edition, discoveryStatement('schema:exampleOfWork', work.id));
  await fixture.adopt(edition, discoveryStatement('schema:inLanguage', 'ja'));
  await fixture.adopt(edition, discoveryStatement('schema:publisher', publisher.id));
  await fixture.catchUp([work, edition, publisher]);

  const page = await fixture.request(
    'anonymous',
    'GET',
    `/v1/subjects/${work.id}/links?property=schema%3AexampleOfWork&limit=20&language=en`,
  );
  expect(page.status, JSON.stringify(page.body)).toBe(200);
  const body = page.body as {
    links: WorkReleaseCardMembershipLink[];
    workReleaseCards: { state: string; cards?: Record<string, any>[] };
  };
  expect(body.workReleaseCards.state).toBe('available');
  const publicCard = body.workReleaseCards.cards!.find(({ subject }) => subject === edition.id)!;
  expect(publicCard.fields['schema:inLanguage'].statements[0].value.content).toBe('ja');
  expect(publicCard.fields['schema:publisher'].related[publisher.id].label.value).toContain('Deadline-bound publisher');

  const pool = kernelPool;
  if (!pool) throw new Error('Native fixture did not expose its kernel pool');
  const routeKey = new Uint8Array(32);
  const readCards = (deadline: number, authorizeSummary: (id: string) => Promise<boolean>) =>
    readNativeWorkReleaseCards({
      pool,
      routeKey,
      subject: work.id,
      links: body.links,
      caughtUp: true,
      release: fixture.release.definition,
      languages: ['en'],
      deadline,
      seen: [],
      authorizeSummary: async (_client, id) => authorizeSummary(id),
    });

  let sufficientBudgetSummaryCalls = 0;
  const sufficientBudget = await readCards(Date.now() + 5_000, async () => {
    sufficientBudgetSummaryCalls += 1;
    return true;
  });
  expect(sufficientBudget.state).toBe('available');
  if (sufficientBudget.state !== 'available') throw new Error('Sufficient-budget Book cards became unavailable');
  const currentCard = sufficientBudget.cards.find(({ subject }) => subject === edition.id)!;
  expect(currentCard.fields['schema:inLanguage']).toMatchObject({
    state: 'available',
    statements: [{ value: { content: 'ja' } }],
  });
  expect(currentCard.fields['schema:publisher']).toMatchObject({
    state: 'available',
    statements: [{ value: { content: publisher.id } }],
  });
  expect(sufficientBudgetSummaryCalls).toBeGreaterThan(0);

  selectedFieldQueryCount = 0;
  postSlowFieldQueryCount = 0;
  slowFieldReleaseError = undefined;
  slowFieldQuerySettled = new Promise<void>((resolve) => {
    completeSlowFieldQuery = () => resolve();
  });
  observeSelectedFieldQueries = true;
  const started = Date.now();
  const deadline = started + 1_000;
  let summaryCalls = 0;
  const result = await readCards(deadline, async () => {
    summaryCalls += 1;
    return true;
  });
  const elapsed = Date.now() - started;
  if (slowFieldQuerySettled && slowFieldClient) await slowFieldQuerySettled;
  observeSelectedFieldQueries = false;

  expect(result).toEqual({ state: 'unavailable' });
  expect(elapsed).toBeLessThan(1_100);
  expect(selectedFieldQueryCount).toBe(1);
  expect(postSlowFieldQueryCount).toBe(0);
  expect(slowFieldReleaseError).toBeInstanceOf(Error);
  expect(summaryCalls).toBe(0);
});
