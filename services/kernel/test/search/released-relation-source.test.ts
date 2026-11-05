import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { HttpResponse, SearchDriver } from '../../../../specs/search-driver.ts';
import { subjectPartition } from '../../src/search/source.ts';
import { createDriverClient, type DriverClient } from './support/driver-client.ts';

const clients = new Set<DriverClient>();
afterEach(async () => {
  const results = await Promise.allSettled([...clients].map((client) => client.close()));
  clients.clear();
  const failures = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
  if (failures.length) throw new AggregateError(failures, 'Released relation fixtures did not drain');
}, 600_000);

const marker = () => `relation${randomUUID().replaceAll('-', '').replace(/[0-9]/g, 'a')}`;
const snak = (property: string, content: unknown) => ({
  property: { id: property },
  value: { type: 'value', content },
});
async function post(driver: SearchDriver, path: string, body: unknown, persona: 'editor' | 'acceptor' = 'editor') {
  return driver.request(persona, 'POST', path, body, { 'Idempotency-Key': JSON.stringify(randomUUID()) });
}
async function create(driver: SearchDriver, type: string, label: string) {
  const response = await post(driver, '/v1/subjects', {
    type,
    labels: { en: label },
    aliases: { en: [`${label} alias`] },
    descriptions: { en: `${label} description` },
    statements: {},
  });
  expect([response.status, response.body.code]).toEqual([201, undefined]);
  expect(response.headers.get('rezics-session-token')).toBeTruthy();
  return (response.body.subject as { id: string }).id;
}
async function propose(driver: SearchDriver, book: string, author: string, creditedAs: string) {
  const response = await post(driver, `/v1/subjects/${book}/candidates`, {
    statement: {
      ...snak('schema:author', author),
      rank: 'normal',
      qualifiers: [snak('wdt:P1932', creditedAs)],
      references: [{ parts: [snak('schema:url', 'https://example.test/released-author')] }],
    },
  });
  expect([response.status, response.body.code]).toEqual([201, undefined]);
  const candidate = response.body.candidate as string;
  const acceptance = await post(
    driver,
    `/v1/subjects/${book}/candidates/${candidate}:accept`,
    {
      context: driver.globalContext,
      expected_head: null,
    },
    'acceptor',
  );
  expect([acceptance.status, acceptance.body.code]).toEqual([200, undefined]);
  return candidate;
}
async function adopt(
  driver: SearchDriver,
  book: string,
  author: string,
  candidate: string,
  rank: 'normal' | 'preferred',
  expected_head: number | null,
) {
  const response = await post(
    driver,
    `/v1/subjects/${book}:adopt`,
    {
      context: driver.globalContext,
      property: 'schema:author',
      target: author,
      mode: 'replace',
      selection: [{ candidate, rank }],
      expected_head,
    },
    'acceptor',
  );
  expect([response.status, response.body.code]).toEqual([200, undefined]);
  return (response.body.adoption as { head: number }).head;
}
function related(driver: SearchDriver, text: string, author: string) {
  return driver.request('anonymous', 'POST', '/v1/subjects:search', {
    text,
    filter: {
      and: [{ type: { in: ['schema:Book'] } }, { statement: { property: 'schema:author', in: [author] } }],
    },
    descriptions: true,
    limit: 20,
  });
}
function ids(response: HttpResponse) {
  expect([response.status, response.body.code]).toEqual([200, undefined]);
  return (response.body.subjects as { id: string }[]).map(({ id }) => id).sort();
}
async function eventually(read: () => Promise<HttpResponse>, expected: string[]) {
  const deadline = performance.now() + 20_000;
  let last: HttpResponse | undefined;
  do {
    last = await read();
    if (last.status === 200 && JSON.stringify(ids(last)) === JSON.stringify(expected)) return last;
    await Bun.sleep(50);
  } while (performance.now() < deadline);
  throw new Error(`Native released relation did not converge to ${JSON.stringify(expected)}: ${JSON.stringify(last)}`);
}

test('released author adoption reaches exactly its book through the native default Semantic and Search consumers', async () => {
  const client = createDriverClient();
  clients.add(client);
  const driver = await client.init();
  const text = marker();
  const author = await create(driver, 'schema:Person', `${text} author`);
  const book = await create(driver, 'schema:Book', `${text} book`);
  await create(driver, 'schema:Book', `${text} unrelated`);
  const candidate = await propose(driver, book, author, 'Released credited name');
  await adopt(driver, book, author, candidate, 'preferred', null);
  const response = await eventually(() => related(driver, text, author), [book]);
  expect(response.body.subjects).toEqual([
    expect.objectContaining({
      id: book,
      labels: { en: `${text} book` },
      descriptions: { en: `${text} book description` },
    }),
  ]);
  const stats = (await client.inspect()).workerStats!;
  expect(stats.registeredModules).toEqual(stats.defaultModules);
  for (const name of ['semantic', 'search']) {
    expect(stats.registrationCounts[name]).toBe(1);
    expect(stats.startedServices[name]).toBeGreaterThan(0);
  }
  expect(stats.searchStarterInvocations).toBe(1);
  expect((await driver.request('suspended', 'GET', `/v1/subjects/${book}`)).status).toBe(401);
}, 600_000);

test('a foreign target reduction with Search paused withholds adopted relation evidence before and after delayed repair', async () => {
  const client = createDriverClient();
  clients.add(client);
  const driver = await client.init();
  const text = marker();
  const author = await create(driver, 'schema:Person', `${text} foreign author`);
  let book: string;
  do {
    book = await create(driver, 'schema:Book', `${text} book`);
  } while (subjectPartition(book) === subjectPartition(author));
  const candidate = await propose(driver, book, author, 'Foreign credited name');
  await adopt(driver, book, author, candidate, 'normal', null);
  await eventually(() => related(driver, text, author), [book]);
  await driver.indexing('paused');
  await driver.remove(author, 'hidden');
  expect(ids(await related(driver, text, author))).toEqual([]);
  await driver.indexing('running');
  await eventually(() => related(driver, text, author), []);
  expect(ids(await related(driver, text, author))).toEqual([]);
}, 600_000);

test('current candidate replacement and rank are observed while Search retains its earlier source body', async () => {
  const client = createDriverClient();
  clients.add(client);
  const driver = await client.init();
  const text = marker();
  const author = await create(driver, 'schema:Person', `${text} author`);
  const book = await create(driver, 'schema:Book', `${text} book`);
  const first = await propose(driver, book, author, 'Earlier credited name');
  const head = await adopt(driver, book, author, first, 'normal', null);
  await eventually(() => related(driver, text, author), [book]);
  await driver.indexing('paused');
  const replacement = await propose(driver, book, author, 'Current credited name');
  await adopt(driver, book, author, replacement, 'preferred', head);
  const response = await driver.request('anonymous', 'GET', `/v1/subjects/${book}`);
  expect(response.status).toBe(200);
  const subject = response.body.subject as { statements: Record<string, { id: string; rank: string }[]> };
  expect(subject.statements['schema:author']).toEqual([
    expect.objectContaining({ id: replacement, rank: 'preferred' }),
  ]);
  expect(ids(await related(driver, text, author))).toEqual([book]);
  await driver.indexing('running');
  await eventually(() => related(driver, text, author), [book]);
}, 600_000);

test('source moderation with Search paused withholds the released book before and after delayed repair', async () => {
  const client = createDriverClient();
  clients.add(client);
  const driver = await client.init();
  const text = marker();
  const author = await create(driver, 'schema:Person', `${text} author`);
  const book = await create(driver, 'schema:Book', `${text} book`);
  const candidate = await propose(driver, book, author, 'Released credited name');
  await adopt(driver, book, author, candidate, 'normal', null);
  await eventually(() => related(driver, text, author), [book]);

  await driver.indexing('paused');
  await driver.remove(book, 'hidden');
  expect(ids(await related(driver, text, author))).toEqual([]);
  expect((await driver.request('anonymous', 'GET', `/v1/subjects/${book}`)).status).toBe(404);

  await driver.indexing('running');
  await eventually(() => related(driver, text, author), []);
  expect(ids(await related(driver, text, author))).toEqual([]);
}, 600_000);
