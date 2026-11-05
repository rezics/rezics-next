import { afterEach, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { HttpResponse, Persona, SearchDriver } from './search-driver';
import type { Labels, StatementInput, Subject } from './semantic-driver';

setDefaultTimeout(300_000);
let driver: SearchDriver;
let marker: string;
beforeEach(async () => {
  const location = process.env.SEARCH_DRIVER;
  if (!location) throw new Error('Search outcome driver is required');
  if (!isAbsolute(location) && !location.startsWith('file:'))
    throw new Error('SEARCH_DRIVER must be absolute or a file URL');
  const url = isAbsolute(location) ? pathToFileURL(location) : new URL(location);
  if (url.protocol !== 'file:') throw new Error('SEARCH_DRIVER must use a file URL');
  const binding = await import(url.href);
  if (typeof binding.createSearchDriver !== 'function') throw new Error('Expected createSearchDriver factory');
  driver = await binding.createSearchDriver();
  marker = `relations${randomUUID()
    .replaceAll('-', '')
    .replace(/[0-9]/g, (digit) => String.fromCharCode(97 + Number(digit)))}`;
});
afterEach(async () => {
  const current = driver;
  driver = undefined!;
  await current?.close();
});
const path = (id: string) => `/v1/subjects/${id}`;
const write = (persona: Persona, route: string, body: unknown) =>
  driver.request(persona, 'POST', route, body, { 'Idempotency-Key': `"${randomUUID()}"` });
const bookType = { type: { in: ['schema:Book'] } };
const authorFilter = (author: Subject) => ({ statement: { property: 'schema:author', in: [author.id] } });
const anchored = (filter: unknown) => ({ and: [bookType, filter] });
const authorStatement = (author: Subject): StatementInput => ({
  property: { id: 'schema:author' },
  value: { type: 'value', content: author.id },
  rank: 'normal',
});
interface Hit {
  id: string;
  type: string;
  labels: Labels;
}
function hits(response: HttpResponse, limit = 20): Hit[] {
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('application/json');
  expect(Array.isArray(response.body.subjects)).toBe(true);
  const subjects = response.body.subjects as Hit[];
  expect(subjects.length).toBeLessThanOrEqual(limit);
  expect(new Set(subjects.map((subject) => subject.id)).size).toBe(subjects.length);
  for (const subject of subjects)
    expect(subject).toMatchObject({
      id: expect.any(String),
      type: expect.any(String),
      labels: expect.any(Object),
    });
  // Summaries and other public hit enrichments are returned unchanged by the driver.
  expect(Number.isFinite(Date.parse(response.body.as_of as string))).toBe(true);
  return subjects;
}
const ids = (subjects: Hit[]) => subjects.map((subject) => subject.id).sort();
async function search(filter: unknown = bookType, persona: Persona = 'anonymous', text = marker) {
  const response = await driver.request(persona, 'POST', '/v1/subjects:search', { text, filter, limit: 20 });
  const subjects = hits(response);
  expect(response.body.next).toBeNull(); // Fixtures contain at most three matching Books.
  return subjects;
}
async function suggestions(persona: Persona = 'anonymous') {
  return hits(await driver.request(persona, 'GET', `/v1/subjects:suggest?q=${marker}&limit=10`), 10);
}
async function eventually<T>(read: () => Promise<T>, ready: (result: T) => boolean) {
  const deadline = performance.now() + 15_000;
  do {
    const result = await read();
    if (ready(result)) {
      expect(performance.now()).toBeLessThanOrEqual(deadline);
      return result;
    }
    await Bun.sleep(50);
  } while (performance.now() < deadline);
  throw new Error('Search outcome did not become visible within 15 seconds');
}
const sameIds = (actual: Hit[], expected: Subject[]) =>
  JSON.stringify(ids(actual)) === JSON.stringify(expected.map((subject) => subject.id).sort());
const expectIds = (actual: Hit[], expected: Subject[]) =>
  expect(ids(actual)).toEqual(expected.map((subject) => subject.id).sort());
async function create(label: string, authors: Subject[] = [], type = 'schema:Book') {
  const response = await write('editor', '/v1/subjects', {
    type,
    labels: { en: `${type === 'schema:Person' ? `people${marker}` : marker} ${label}` },
    statements: authors.length ? { 'schema:author': authors.map(authorStatement) } : {},
  });
  expect(response.status).toBe(201);
  const subject = response.body.subject as Subject;
  expect(response.headers.get('location')).toBe(path(subject.id));
  expect(response.headers.get('rezics-session-token')).toBeTruthy();
  return subject;
}
async function propose(book: Subject, author: Subject) {
  const response = await write('editor', `${path(book.id)}/candidates`, {
    statement: {
      ...authorStatement(author),
      references: [
        {
          parts: [
            {
              property: { id: 'schema:url' },
              value: { type: 'value', content: 'https://example.org/reference' },
            },
          ],
        },
      ],
    },
  });
  expect(response.status).toBe(201);
  expect(typeof response.body.candidate).toBe('string');
  return response.body.candidate as string;
}
async function accept(book: Subject, candidate: string) {
  expect(
    (
      await write('acceptor', `${path(book.id)}/candidates/${candidate}:accept`, {
        context: driver.globalContext,
        expected_head: null,
      })
    ).status,
  ).toBe(200);
}
async function adopt(book: Subject, author: Subject, candidate: string) {
  // Relation adoption addresses a per-target slot, not the old property-wide slot.
  expect(
    (
      await write('acceptor', `${path(book.id)}:adopt`, {
        context: driver.globalContext,
        property: 'schema:author',
        target: author.id,
        mode: 'replace',
        selection: [{ candidate, rank: 'normal' }],
        expected_head: null,
      })
    ).status,
  ).toBe(200);
}
async function indexed(books: Subject[]) {
  await eventually(
    () => search(),
    (result) => sameIds(result, books),
  );
}
async function people(count: number) {
  const result: Subject[] = [];
  for (let index = 0; index < count; index++) result.push(await create(`Author ${index}`, [], 'schema:Person'));
  return result;
}
async function overflowFixture() {
  const authors = await people(130);
  // Two overlapping 129-value sets force both true matches and overflow candidate false positives.
  // Each creation is comfortably below the 512-fact command budget.
  const included = await create('Included', authors.slice(0, 129));
  const other = await create('Other', authors.slice(1));
  const empty = await create('Empty');
  await indexed([included, other, empty]);
  return { authors, included, other, empty };
}
function refused(response: HttpResponse) {
  expect(response.status).toBe(401);
  expect(response.headers.get('content-type')).toContain('application/problem+json');
  expect(response.body).toMatchObject({ code: 'invalid_credentials', status: 401 });
}

test('an adopted author beyond the bounded relation sample matches positive and negated filters', async () => {
  const authors = await people(130);
  const book = await create('Included', authors.slice(0, 128));
  const other = await create('Overflow control', authors.slice(1));
  const empty = await create('Empty');
  await indexed([book, other, empty]);
  const pendingAuthor = authors[128]!;
  const candidate = await propose(book, pendingAuthor);
  const predicate = anchored(authorFilter(pendingAuthor));
  expectIds(await search(predicate), [other]);
  expectIds(await search(anchored({ not: authorFilter(pendingAuthor) })), [book, empty]);
  await accept(book, candidate);
  expectIds(await search(predicate), [other]); // Accepted is still not adopted.
  await adopt(book, pendingAuthor, candidate);
  await eventually(
    () => search(predicate),
    (result) => sameIds(result, [book, other]),
  );

  // Test EVERY one of the 129 authors, rather than assuming insertion/id order is the
  // stored prefix. At most 128 fit: this public-API matrix necessarily tests an omitted
  // author, including its negation and nested forms, whichever sample production chooses.
  for (const [index, author] of authors.slice(0, 129).entries()) {
    const positive = index === 0 ? [book] : [book, other];
    const negative = index === 0 ? [other, empty] : [empty];
    const leaf = authorFilter(author);
    expectIds(await search(anchored(leaf)), positive);
    expectIds(await search(anchored({ not: leaf })), negative);
    const extra = authorFilter(authors[129]!);
    expectIds(await search(anchored({ or: [leaf, { and: [extra, { not: leaf }] }] })), [book, other]);
    expectIds(await search(anchored({ and: [{ not: leaf }, { or: [extra, leaf] }] })), index === 0 ? [other] : []);
    expectIds(await search(anchored({ and: [leaf, { not: extra }] })), [book]);
  }
  // The extra author exists only on the overflowing control; the empty Book never matches.
  expectIds(await search(anchored(authorFilter(authors[129]!))), [other]);
});

interface Bucket {
  value: string;
  labels: Labels;
}
async function facets(filter: unknown) {
  const response = await driver.request('anonymous', 'POST', '/v1/subjects:facets', {
    text: marker,
    filter,
    facets: [
      { property: 'schema:author', size: 20 },
      { property: 'type', size: 1 },
    ],
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('application/json');
  expect(response.body).not.toHaveProperty('total');
  const result = response.body.facets as { property: string; values: Bucket[] }[];
  expect(Array.isArray(result)).toBe(true);
  expect(result.map((facet) => facet.property)).toEqual(['schema:author', 'type']);
  for (const facet of result) {
    expect(facet).not.toHaveProperty('relation');
    for (const bucket of facet.values) expect(bucket).not.toHaveProperty('count');
  }
  return result;
}

test('overflowing author facet values retain their disclosed identities and labels', async () => {
  const { authors, included, other } = await overflowFixture();
  const check = async (filter: unknown) => {
    const result = await facets(filter);
    const authorFacet = result[0]!;
    expect(authorFacet.values.length).toBeGreaterThan(0);
    expect(authorFacet.values.length).toBeLessThanOrEqual(20);
    expect(new Set(authorFacet.values.map((bucket) => bucket.value)).size).toBe(authorFacet.values.length);
    for (const bucket of authorFacet.values) {
      const known = authors.find((author) => author.id === bucket.value);
      expect(known).toBeDefined();
      expect(bucket.labels).toEqual(known!.labels);
    }
    const types = result[1]!.values;
    expect(types).toHaveLength(1);
    expect(types[0]!.value).toBe('schema:Book');
  };
  await check(bookType);
  // The full 130-predicate matrix covers omitted sample values on both overflowing Books.
  // The end predicates also have an overflowing false-positive candidate, so the hit checks
  // continue to prove its exclusion while public aggregate metadata is absent.
  for (const [index, author] of authors.entries()) {
    const matching = index === 0 ? [included] : index === 129 ? [other] : [included, other];
    expectIds(await search(anchored(authorFilter(author))), matching);
    await check(anchored(authorFilter(author)));
  }
});

test('overflow rechecks keep hidden and taken-down source subjects out while indexing is paused', async () => {
  const { authors, included, other, empty } = await overflowFixture();
  // Establish every predicate before pausing, so stale/missing setup cannot pass a removal assertion.
  for (const [index, author] of authors.entries()) {
    expectIds(
      await search(anchored(authorFilter(author))),
      index === 0 ? [included] : index === 129 ? [other] : [included, other],
    );
  }
  await eventually(
    () => suggestions(),
    (result) => sameIds(result, [included, other, empty]),
  );
  await driver.indexing('paused');
  try {
    await driver.remove(included.id, 'hidden');
    expectIds(await search(anchored(authorFilter(authors[0]!))), []);
    expectIds(await search(anchored({ not: authorFilter(authors[0]!) })), [other, empty]);
    expectIds(await search(anchored(authorFilter(authors[129]!))), [other]);
    expectIds(await suggestions(), [other, empty]);
    await driver.remove(other.id, 'taken_down');
    for (const persona of ['anonymous', 'editor'] as const) {
      for (const author of authors) {
        expectIds(await search(anchored(authorFilter(author)), persona), []);
        expectIds(await search(anchored({ not: authorFilter(author) }), persona), [empty]);
      }
      expectIds(await search(bookType, persona), [empty]);
      expectIds(await suggestions(persona), [empty]);
      for (const removed of [included, other]) {
        const read = await driver.request(persona, 'GET', path(removed.id));
        expect(read.status).toBe(404);
        expect(read.body.code).toBe('not_found');
      }
    }
    // Protected relations cannot contribute public facet values through stale index documents.
    const result = await facets(bookType);
    expect(result[0]!.values).toEqual([]);
    expect(result[1]!.values.map(({ value }) => value)).toEqual(['schema:Book']);
  } finally {
    await driver.indexing('running');
  }
  await indexed([empty]);
});

test('a declared author relation update refreshes its source subject', async () => {
  const author = await create('New author', [], 'schema:Person');
  const book = await create('Source');
  const control = await create('Control');
  await indexed([book, control]);
  const leaf = authorFilter(author);
  const positive = anchored(leaf);
  const negative = anchored({ not: leaf });
  expectIds(await search(positive), []);
  expectIds(await search(negative), [book, control]);
  const candidate = await propose(book, author);
  expectIds(await search(positive), []);
  await accept(book, candidate);
  expectIds(await search(positive), []);
  await adopt(book, author, candidate);
  // One fifteen-second deadline covers both views of the changed source predicate.
  await eventually(
    async () => ({ yes: await search(positive), no: await search(negative) }),
    (result) => sameIds(result.yes, [book]) && sameIds(result.no, [control]),
  );
  for (const persona of ['anonymous', 'editor'] as const) {
    expectIds(await search(positive, persona), [book]);
    expectIds(await search(negative, persona), [control]);
    // The Person target is independently indexed. Its inbound edge must never be
    // interpreted as an outgoing author, with either endpoint as the queried value.
    await eventually(
      () => search({ type: { in: ['schema:Person'] } }, persona, `people${marker}`),
      (result) => result.some((item) => item.id === author.id),
    );
    for (const target of [author, book]) {
      expectIds(await search(authorFilter(target), persona, `people${marker}`), []);
    }
  }
  refused(await driver.request('suspended', 'POST', '/v1/subjects:search', { text: marker, filter: positive }));
  refused(await driver.request('suspended', 'GET', `/v1/subjects:suggest?q=${marker}`));
});

test('hiding a relation target suppresses positive source hits before the rebuild', async () => {
  const authors = await people(130);
  const hiddenTarget = authors[0]!;
  const takenDownTarget = authors[129]!;
  const single = await create('Single author', [hiddenTarget]);
  const overflowing = await create('Overflowing authors', authors.slice(1));
  const books = [single, overflowing];
  await indexed(books);
  const singlePredicate = anchored(authorFilter(hiddenTarget));
  const overflowPredicate = anchored(authorFilter(takenDownTarget));
  // Both positive witnesses must be indexed before removal, under one explicit deadline.
  await eventually(
    async () => ({ single: await search(singlePredicate), overflow: await search(overflowPredicate) }),
    (result) => sameIds(result.single, [single]) && sameIds(result.overflow, [overflowing]),
  );
  for (const persona of ['anonymous', 'editor'] as const) {
    expectIds(await search(singlePredicate, persona), [single]);
    expectIds(await search(overflowPredicate, persona), [overflowing]);
    for (const subject of [...books, hiddenTarget, takenDownTarget]) {
      expect((await driver.request(persona, 'GET', path(subject.id))).status).toBe(200);
    }
  }
  await driver.indexing('paused');
  try {
    await driver.remove(hiddenTarget.id, 'hidden');
    for (const persona of ['anonymous', 'editor'] as const) {
      expectIds(await search(singlePredicate, persona), []);
      expectIds(await search(overflowPredicate, persona), [overflowing]);
    }
    await driver.remove(takenDownTarget.id, 'taken_down');
    for (const persona of ['anonymous', 'editor'] as const) {
      expectIds(await search(singlePredicate, persona), []);
      expectIds(await search(overflowPredicate, persona), []);
      // Removal suppresses relation witnesses, while both source Books remain public.
      for (const book of books) {
        expect((await driver.request(persona, 'GET', path(book.id))).status).toBe(200);
      }
    }
    // A negative predicate may conservatively omit a source until its rebuild.
    // No assertion depends on which of the overflowing Book's authors was sampled.
  } finally {
    await driver.indexing('running');
  }
});

test('qualified relation facet filters are refused without changing unqualified author semantics', async () => {
  const author = await create('Author', [], 'schema:Person');
  const book = await create('Qualified relation control', [author]);
  await indexed([book]);
  const leaf = authorFilter(author);
  await eventually(
    () => search(anchored(leaf)),
    (result) => sameIds(result, [book]),
  );
  // The release declares author as a relation and wdt:P3831 as an admitted item
  // qualifier. This well-formed query must fail at qualifiers, not at its contents.
  const qualified = {
    statement: {
      ...leaf.statement,
      qualifiers: [{ property: 'wdt:P3831', in: [author.id] }],
    },
  };
  for (const persona of ['anonymous', 'editor'] as const) {
    expectIds(await search(anchored(leaf), persona), [book]);
    for (const [filter, pointer] of [
      [anchored(qualified), '/filter/and/1/statement/qualifiers'],
      [anchored({ not: qualified }), '/filter/and/1/not/statement/qualifiers'],
    ] as const) {
      for (const route of ['/v1/subjects:search', '/v1/subjects:facets']) {
        const response = await driver.request(persona, 'POST', route, {
          text: marker,
          filter,
          ...(route.endsWith(':facets') ? { facets: [{ property: 'schema:author', size: 20 }] } : { limit: 20 }),
        });
        expect(response.status).toBe(400);
        expect(response.headers.get('content-type')).toContain('application/problem+json');
        expect(response.body).toMatchObject({ code: 'invalid_request', status: 400 });
        expect(response.body.errors).toEqual(expect.arrayContaining([{ pointer, code: 'unsupported' }]));
      }
    }
    expectIds(await search(anchored(leaf), persona), [book]);
  }
});
