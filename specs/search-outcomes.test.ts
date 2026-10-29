import { afterEach, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { HttpResponse, Persona, SearchDriver } from './search-driver';
import type { Labels, StatementInput, Subject } from './semantic-driver';

setDefaultTimeout(60_000);
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
  // A single ASCII word is safe in both the text grammar and prefix suggestions.
  marker = `search${randomUUID()
    .replaceAll('-', '')
    .replace(/[0-9]/g, (digit) => String.fromCharCode(97 + Number(digit)))}`;
});
afterEach(async () => {
  const current = driver;
  driver = undefined!;
  await current?.close();
});
const subjectPath = (id: string) => `/v1/subjects/${id}`;
const get = (path: string, persona: Persona = 'anonymous') => driver.request(persona, 'GET', path);
const search = (body: unknown, persona: Persona = 'anonymous') =>
  driver.request(persona, 'POST', '/v1/subjects:search', body);
const suggest = (q: string, limit?: number, persona: Persona = 'anonymous') =>
  get(`/v1/subjects:suggest?q=${encodeURIComponent(q)}${limit === undefined ? '' : `&limit=${limit}`}`, persona);
const write = (persona: Persona, path: string, body: unknown) =>
  driver.request(persona, 'POST', path, body, { 'Idempotency-Key': `"${randomUUID()}"` });
function problem(response: HttpResponse, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type')).toContain('application/problem+json');
  expect(response.body).toMatchObject({
    type: `https://rezics.com/problems/${code}`,
    status,
    code,
    title: expect.any(String),
    request_id: expect.any(String),
    effect_status: 'not_applicable',
    retryable: expect.any(Boolean),
  });
}
function field(response: HttpResponse, pointer: string, code = expect.any(String)) {
  problem(response, 400, 'invalid_request');
  expect(response.body.errors).toEqual(expect.arrayContaining([{ pointer, code }]));
}
function unsupported(response: HttpResponse, pointer: string, descendants = false) {
  problem(response, 422, 'unsupported_query');
  const errors = response.body.errors as { pointer: string; code: string }[];
  expect(Array.isArray(errors)).toBe(true);
  expect(
    errors.some(
      (error) =>
        (error.pointer === pointer || (descendants && error.pointer.startsWith(`${pointer}/`))) &&
        ['unsupported', 'out_of_range'].includes(error.code),
    ),
  ).toBe(true);
}
interface Hit {
  id: string;
  type: string;
  labels: Labels;
  summary: {
    id: string;
    type: string;
    types: string[];
    label: { language: 'en'; value: string };
    creativeWork: boolean;
    cover: null;
  };
}
function fixtureSummary(subject: Pick<Hit, 'id' | 'type' | 'labels'>): Hit['summary'] {
  if (typeof subject.labels.en !== 'string') throw new Error(`Search fixture ${subject.id} lacks an English label`);
  if (subject.type !== 'schema:Book' && subject.type !== 'schema:Person')
    throw new Error(`Unexpected search fixture type: ${subject.type}`);
  return {
    id: subject.id,
    type: subject.type,
    types:
      subject.type === 'schema:Book'
        ? ['schema:Book', 'schema:CreativeWork', 'schema:Thing']
        : ['schema:Person', 'schema:Thing'],
    label: { language: 'en', value: subject.labels.en },
    creativeWork: subject.type === 'schema:Book',
    cover: null,
  };
}
interface Page {
  subjects: Hit[];
  next: string | null;
  as_of: string;
}
function hits(response: HttpResponse, limit: number) {
  const received = Date.now();
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('application/json');
  const subjects = response.body.subjects as Hit[];
  expect(Array.isArray(subjects)).toBe(true);
  expect(subjects.length).toBeLessThanOrEqual(limit);
  expect(new Set(subjects.map((hit) => hit.id)).size).toBe(subjects.length);
  for (const hit of subjects) {
    expect(hit).toEqual({
      id: expect.any(String),
      type: expect.any(String),
      labels: expect.any(Object),
      summary: fixtureSummary(hit),
    });
    for (const label of Object.values(hit.labels)) expect(typeof label).toBe('string');
  }
  expect(response.body.as_of).toEqual(
    expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/),
  );
  expect(Number.isFinite(Date.parse(response.body.as_of as string))).toBe(true);
  expect(Date.parse(response.body.as_of as string)).toBeLessThanOrEqual(received);
  return subjects;
}
function page(response: HttpResponse, limit = 20): Page {
  hits(response, limit);
  expect(response.body).not.toHaveProperty('total');
  expect(response.body.next === null || typeof response.body.next === 'string').toBe(true);
  return response.body as unknown as Page;
}
const ids = (result: { subjects: Hit[] }) => result.subjects.map((hit) => hit.id);
const hit = (subject: Subject): Hit => ({
  id: subject.id,
  type: subject.type,
  labels: subject.labels,
  summary: fixtureSummary(subject),
});
async function create(
  label: string | Labels,
  options: {
    type?: string;
    aliases?: Record<string, string[]>;
    descriptions?: Labels;
    statements?: Record<string, StatementInput[]>;
  } = {},
) {
  const response = await write('editor', '/v1/subjects', {
    type: 'schema:Book',
    labels: typeof label === 'string' ? { en: `${marker} ${label}` } : label,
    ...options,
  });
  expect(response.status).toBe(201);
  const subject = response.body.subject as Subject;
  expect(response.headers.get('location')).toBe(subjectPath(subject.id));
  expect(response.headers.get('etag')).toBe('"1"');
  expect(response.headers.get('rezics-session-token')).toBeTruthy();
  return subject;
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
async function indexed(subjects: Subject[], body: Record<string, unknown> = { text: marker }) {
  return eventually(
    async () => page(await search(body), Number(body.limit ?? 20)),
    (result) => subjects.every((subject) => ids(result).includes(subject.id)),
  );
}
async function found(subject: Subject, text: string) {
  const result = page(await search({ text: `${marker} ${text}` }));
  expect(result.subjects).toContainEqual(hit(subject));
}
async function absent(subject: Subject, text: string) {
  expect(ids(page(await search({ text: `${marker} ${text}` })))).not.toContain(subject.id);
}
const typeFilter = (type = 'schema:Book') => ({ type: { in: [type] } });
const statement = (property: string, content: string): StatementInput => ({
  property: { id: property },
  value: { type: 'value', content },
  rank: 'normal',
});
const part = (property: string, content: string) => ({ property: { id: property }, value: { type: 'value', content } });

test('Traditional and Simplified Chinese match without matching a different title or an extended phrase', async () => {
  const book = await create({ en: marker, 'zh-Hant': '魔法禁書目錄' });
  await indexed([book]);
  await found(book, '魔法禁书目录');
  await found(book, '魔法禁書目錄');
  await absent(book, '魔法禁書索引');
  await absent(book, '"魔法禁書目録外伝"');
});

test('Kana voicing and width fold with case and full width Latin names', async () => {
  const glass = await create({ en: marker, ja: 'ガラス' });
  const rust = await create({ en: `${marker} ＲＵＳＴ` });
  await indexed([glass, rust]);
  for (const text of ['がらす', 'ｶﾞﾗｽ', 'がらす']) await found(glass, text);
  await absent(glass, 'からす');
  for (const text of ['rust', 'RUST']) await found(rust, text);
  await absent(rust, 'crust');
});

test('Aliases and descriptions are searchable but adopted statement values are not free text', async () => {
  const book = await create('Catalogue', {
    aliases: { en: [`${marker} Secretnickname`] },
    descriptions: { en: `${marker} Secretdescription` },
    statements: { 'schema:url': [statement('schema:url', 'https://example.org/secretstatementword')] },
  });
  expect(book.statements['schema:url']).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ value: { type: 'value', content: 'https://example.org/secretstatementword' } }),
    ]),
  );
  await indexed([book]);
  await found(book, 'Secretnickname');
  await found(book, 'Secretdescription');
  await absent(book, 'secretstatementword');
});

test('Search is public for editor and anonymous while suspended credentials fail on both routes', async () => {
  const book = await create('Public');
  await indexed([book]);
  const anonymous = page(await search({ text: marker }));
  const editor = page(await search({ text: marker }, 'editor'));
  expect(anonymous).not.toHaveProperty('total');
  expect(editor).not.toHaveProperty('total');
  expect(editor.subjects).toEqual(anonymous.subjects);
  expect(editor.subjects).toContainEqual(hit(book));
  expect(page(await search({ text: marker, sort: 'relevance' })).subjects).toEqual(anonymous.subjects);
  await eventually(
    async () => hits(await suggest(marker), 8),
    (result) => result.some((item) => item.id === book.id),
  );
  expect(hits(await suggest(marker, undefined, 'editor'), 8)).toEqual(hits(await suggest(marker), 8));
  problem(await search({ text: marker }, 'suspended'), 401, 'invalid_credentials');
  problem(await suggest(marker, undefined, 'suspended'), 401, 'invalid_credentials');
});

test('New subjects become searchable and suggestible within fifteen seconds with current as_of', async () => {
  const started = Date.now();
  const book = await create('Fresh');
  // One deadline covers both routes, rather than granting each fifteen seconds.
  const visible = await eventually(
    async () => {
      const response = await search({ text: marker });
      const suggestion = await suggest(marker);
      return { result: page(response), suggestions: hits(suggestion, 8), suggestion };
    },
    (result) => ids(result.result).includes(book.id) && result.suggestions.some((item) => item.id === book.id),
  );
  expect(visible.result.subjects).toContainEqual(hit(book));
  expect(visible.suggestions).toContainEqual(hit(book));
  expect(Date.parse(visible.result.as_of)).toBeGreaterThanOrEqual(started);
  expect(Date.parse(visible.suggestion.body.as_of as string)).toBeGreaterThanOrEqual(started);
  const read = await get(subjectPath(book.id));
  expect(read.status).toBe(200);
  expect((read.body.subject as Subject).labels).toEqual(book.labels);
  await absent(book, 'unrelatedfreshword');
});

test('Statement filters use adopted Global values and positive roots admit bounded negation', async () => {
  const author = await create('Author', { type: 'schema:Person' });
  const book = await create('Included');
  const other = await create('Excluded');
  const proposal = await write('editor', `${subjectPath(book.id)}/candidates`, {
    statement: {
      ...statement('schema:author', author.id),
      references: [{ parts: [part('schema:url', 'https://example.org/reference')] }],
    },
  });
  expect(proposal.status).toBe(201);
  const candidate = proposal.body.candidate as string;
  await indexed([author, book, other]);
  const filter = { statement: { property: 'schema:author', in: [author.id] } };
  expect(ids(page(await search({ text: marker, filter })))).not.toContain(book.id);
  const accepted = await write('acceptor', `${subjectPath(book.id)}/candidates/${candidate}:accept`, {
    context: driver.globalContext,
    expected_head: null,
  });
  expect(accepted.status).toBe(200);
  // Acceptance alone does not adopt a pending candidate.
  expect(ids(page(await search({ text: marker, filter })))).not.toContain(book.id);
  const adopted = await write('acceptor', `${subjectPath(book.id)}:adopt`, {
    context: driver.globalContext,
    property: 'schema:author',
    target: author.id,
    mode: 'replace',
    selection: [{ candidate, rank: 'normal' }],
    expected_head: null,
  });
  expect(adopted.status).toBe(200);
  const result = await indexed([book], { text: marker, filter });
  expect(ids(result)).toEqual([book.id]);
  const books = page(await search({ text: marker, filter: typeFilter() }));
  expect(new Set(ids(books))).toEqual(new Set([book.id, other.id]));
  expect(ids(books)).not.toContain(author.id);
  const excluded = page(await search({ text: marker, filter: { and: [typeFilter(), { not: filter }] } }));
  expect(ids(excluded)).toEqual([other.id]);
  unsupported(await search({ text: '-Excluded' }), '/text');
  unsupported(await search({ filter: { not: typeFilter() } }), '/filter');
  const bounded = page(await search({ text: '-Excluded', filter: typeFilter() }));
  expect(ids(bounded)).toContain(book.id);
  expect(ids(bounded)).not.toContain(other.id);
  unsupported(await search({ filter: typeFilter(), sort: 'relevance' }), '/sort');
});

test('Committed takedown and hiding remove stale hits immediately and refill pages while indexing is paused', async () => {
  const subjects: Subject[] = [];
  for (const label of ['A', 'B', 'C', 'D', 'E']) subjects.push(await create(label));
  await indexed(subjects);
  await eventually(
    async () => hits(await suggest(marker, 10), 10),
    (result) => result.length === 5,
  );
  const [taken, hidden, ...siblings] = subjects as [Subject, Subject, ...Subject[]];
  await driver.indexing('paused');
  try {
    const check = async (removed: Subject[], survivors: Subject[]) => {
      for (const persona of ['anonymous', 'editor'] as const) {
        const result = page(await search({ text: marker, sort: 'name', limit: 3 }, persona), 3);
        expect(result.subjects).toEqual(survivors.slice(0, 3).map(hit));
        const suggestions = hits(await suggest(marker, 10, persona), 10);
        for (const subject of removed) {
          expect(ids(result)).not.toContain(subject.id);
          expect(suggestions.map((item) => item.id)).not.toContain(subject.id);
          problem(await get(subjectPath(subject.id), persona), 404, 'not_found');
        }
        for (const subject of survivors) expect(suggestions).toContainEqual(hit(subject));
      }
    };
    await driver.remove(taken.id, 'taken_down');
    await check([taken], [hidden, ...siblings]);
    await driver.remove(hidden.id, 'hidden');
    await check([taken, hidden], siblings);
    await driver.indexing('running');
    await indexed(siblings);
    await check([taken, hidden], siblings);
  } finally {
    await driver.indexing('running');
  }
});

test('Name paging has stable ties and request principal and signature bound tokens', async () => {
  const first = await create({ aa: `${marker} Alpha`, en: `${marker} Zulu` });
  const tie = await create({ en: `${marker} ＡＬＰＨＡ` });
  const beta = await create('Beta');
  const gamma = await create('Gamma');
  const omega = await create('Omega', { aliases: { en: [marker] } });
  const subjects = [first, tie, beta, gamma, omega];
  await indexed(subjects);
  const expected = [...[first, tie].sort((a, b) => (a.id < b.id ? -1 : 1)), beta, gamma, omega];
  const body = { text: marker, sort: 'name', limit: 2 };
  const one = page(await search(body), 2);
  expect(typeof one.next).toBe('string');
  const two = page(await search({ ...body, cursor: one.next }), 2);
  expect(typeof two.next).toBe('string');
  const three = page(await search({ ...body, cursor: two.next }), 2);
  for (const result of [one, two, three]) expect(result).not.toHaveProperty('total');
  expect([one.subjects.length, two.subjects.length, three.subjects.length]).toEqual([2, 2, 1]);
  const all = [...one.subjects, ...two.subjects, ...three.subjects];
  expect(all).toEqual(expected.map(hit));
  expect(new Set(all.map((item) => item.id)).size).toBe(5);
  expect(three.next).toBeNull();
  const token = one.next!;
  field(await search({ ...body, text: `${marker} changed`, cursor: token }), '/cursor');
  field(await search({ ...body, cursor: token }, 'editor'), '/cursor');
  const tampered = `${token[0] === 'A' ? 'B' : 'A'}${token.slice(1)}`;
  field(await search({ ...body, cursor: tampered }), '/cursor');
  // Default name sort without text and explicit id sort use the same five hits.
  const byName = page(await search({ filter: typeFilter() }));
  expect(byName.subjects.filter((item) => subjects.some((subject) => subject.id === item.id))).toEqual(
    expected.map(hit),
  );
  const byId = page(await search({ text: marker, sort: 'id' }));
  expect(ids(byId)).toEqual(subjects.map((subject) => subject.id).sort());
});

test('Rebuild invalidates old page tokens and preserves all visible subjects while excluding takedowns', async () => {
  const subjects = [await create('A'), await create('B'), await create('C')];
  await indexed(subjects);
  const body = { text: marker, sort: 'id', limit: 1 };
  const before = page(await search(body), 1);
  expect(typeof before.next).toBe('string');
  await driver.remove(subjects[0]!.id, 'taken_down');
  const rebuilt = await driver.rebuild();
  expect(Number.isInteger(rebuilt.generation)).toBe(true);
  problem(await search({ ...body, cursor: before.next }), 409, 'search_restart_required');
  const fresh = page(await search({ text: marker, sort: 'id' }));
  expect(new Set(ids(fresh))).toEqual(new Set(subjects.slice(1).map((subject) => subject.id)));
  expect(ids(fresh)).not.toContain(subjects[0]!.id);
  expect(fresh).not.toHaveProperty('total');
  expect(fresh.next).toBeNull();
  expect(hits(await suggest(marker), 8).map((item) => item.id)).not.toContain(subjects[0]!.id);
});

test('Typeahead matches word prefixes in Latin Chinese and aliases and rejects invalid query parameters', async () => {
  const kokoro = await create('Kokoro');
  const magic = await create({ en: marker, 'zh-Hant': '魔法禁書目錄' });
  const alias = await create('Novel', { aliases: { en: [`${marker} Kokochan`] } });
  await indexed([kokoro, magic, alias]);
  const latin = await eventually(
    async () => hits(await suggest('Koko'), 8),
    (result) => [kokoro, alias].every((subject) => result.some((item) => item.id === subject.id)),
  );
  expect(latin).toContainEqual(hit(kokoro));
  expect(latin).toContainEqual(hit(alias));
  const chinese = await eventually(
    async () => hits(await suggest('魔法'), 8),
    (result) => result.some((item) => item.id === magic.id),
  );
  expect(chinese).toContainEqual(hit(magic));
  expect(chinese.map((item) => item.id)).not.toContain(kokoro.id);
  expect(hits(await suggest('okor'), 8).map((item) => item.id)).not.toContain(kokoro.id);
  expect(hits(await suggest('Koko', 1), 1)).toHaveLength(1);
  for (const q of ['', '界'.repeat(65), '😀'.repeat(65)]) field(await suggest(q), '/q');
  for (const limit of [0, 11, 1.5]) field(await suggest('Koko', limit), '/limit');
});

test('Text admission rejects malformed syntax and budgets while all operators produce observable matches', async () => {
  const book = await create('Alpha Beta Gamma');
  const excluded = await create('Delta');
  await indexed([book, excluded]);
  for (const text of [
    '"unclosed',
    'bad\\q',
    '()',
    Array(65).fill('word').join(' '),
    '(((((word)))))',
    'x'.repeat(513),
    '界'.repeat(171),
    `"${Array(33).fill('word').join(' ')}"`,
  ]) {
    unsupported(await search({ text }), '/text');
  }
  const valid = page(await search({ text: `${marker} ("Alpha Beta" | Delta) -Delta` }));
  expect(valid.subjects).toEqual([hit(book)]);
  expect(ids(valid)).not.toContain(excluded.id);
  for (const escape of ['\\\\', '\\"', '\\|', '\\(', '\\)', '\\-']) {
    page(await search({ text: `${marker} | "literal${escape}value"` }));
  }
});

test('Filter admission rejects excessive budgets unknown facets and malformed search bodies', async () => {
  const book = await create('Admission');
  await indexed([book]);
  let deep: unknown = typeFilter();
  for (let depth = 0; depth < 5; depth++) deep = { and: [deep] };
  for (const filter of [
    { and: Array.from({ length: 33 }, () => typeFilter()) },
    { or: Array.from({ length: 17 }, () => typeFilter()) },
    { statement: { property: 'schema:author', in: Array.from({ length: 65 }, () => Bun.randomUUIDv7()) } },
    deep,
  ])
    unsupported(await search({ text: marker, filter }), '/filter', true);
  field(await search({ text: marker, filter: { unknownFacet: { in: ['x'] } } }), '/filter/unknownFacet');
  for (const filter of [{ and: 'bad' }, { type: { in: 'schema:Book' } }, { statement: { property: 3, in: [] } }]) {
    const response = await search({ text: marker, filter });
    problem(response, 400, 'invalid_request');
    expect((response.body.errors as { pointer: string }[]).some((error) => error.pointer.startsWith('/filter/'))).toBe(
      true,
    );
  }
  for (const limit of [0, 101, 1.5, '2']) field(await search({ text: marker, limit }), '/limit');
  field(await search({ text: marker, unknown: true }), '/unknown');
  problem(await search([]), 400, 'invalid_request');
  expect(
    (await indexed([book], { text: marker, filter: { or: [typeFilter(), typeFilter('schema:Person')] }, limit: 100 }))
      .subjects,
  ).toContainEqual(hit(book));
});

test('Unavailable index returns retryable problems on both routes while subject reads keep working', async () => {
  const book = await create('Available');
  await indexed([book]);
  await driver.searchNode('down');
  try {
    for (const response of [await search({ text: marker }), await suggest(marker)]) {
      problem(response, 503, 'index_not_ready');
      expect(response.body.retryable).toBe(true);
      expect(response.headers.get('retry-after')).toBeTruthy();
    }
    const read = await get(subjectPath(book.id));
    expect(read.status).toBe(200);
    expect((read.body.subject as Subject).id).toBe(book.id);
  } finally {
    await driver.searchNode('up');
  }
  expect((await indexed([book])).subjects).toContainEqual(hit(book));
  await eventually(
    async () => hits(await suggest(marker), 8),
    (result) => result.some((item) => item.id === book.id),
  );
  await absent(book, 'unrelatedavailabilityword');
});
