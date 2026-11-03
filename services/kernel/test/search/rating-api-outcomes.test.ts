import { afterEach, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { HttpResponse, Persona, SearchDriver } from '../../../../specs/search-driver.ts';
import type { Labels, Subject } from '../../../../specs/semantic-driver.ts';
import { createSearchDriver } from './outcome-driver.ts';

// Unrated Global outcomes only. Numeric rated ordering, public figures/native
// votes and private Realm outcomes require separate suites.
setDefaultTimeout(600_000);
let driver: SearchDriver | undefined;
let marker: string;
beforeEach(async () => {
  driver = await createSearchDriver();
  marker = `rating${randomUUID()
    .replaceAll('-', '')
    .replace(/[0-9]/g, (digit) => String.fromCharCode(97 + Number(digit)))}`;
});
afterEach(async () => {
  const current = driver;
  driver = undefined;
  await current?.close();
});

const search = (body: unknown, persona: Persona = 'anonymous') =>
  driver!.request(persona, 'POST', '/v1/subjects:search', body);
const typeFilter = (type = 'schema:Book') => ({ type: { in: [type] } });
const query = () => ({ text: marker, filter: typeFilter(), sort: 'rating', limit: 2 });

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
function field(response: HttpResponse, pointer: string) {
  problem(response, 400, 'invalid_request');
  expect(response.body.errors).toEqual(expect.arrayContaining([{ pointer, code: expect.any(String) }]));
}
type Hit = Pick<Subject, 'id' | 'type' | 'labels'> & {
  summary: {
    id: string;
    type: string;
    types: string[];
    label: { language: 'en'; value: string };
    creativeWork: boolean;
    cover: null;
  };
};
type Page = {
  subjects: Hit[];
  next: string | null;
  as_of: string;
};
function hit(subject: Subject): Hit {
  return {
    id: subject.id,
    type: subject.type,
    labels: subject.labels,
    summary: {
      id: subject.id,
      type: subject.type,
      types: ['schema:Book', 'schema:CreativeWork', 'schema:Thing'],
      label: { language: 'en', value: subject.labels.en! },
      creativeWork: true,
      cover: null,
    },
  };
}
function page(response: HttpResponse, limit = 2): Page {
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('application/json');
  const result = response.body as unknown as Page;
  expect(Array.isArray(result.subjects)).toBe(true);
  expect(result.subjects.length).toBeLessThanOrEqual(limit);
  expect(new Set(result.subjects.map((subject) => subject.id)).size).toBe(result.subjects.length);
  expect(result).not.toHaveProperty('total');
  expect(result).not.toHaveProperty('count');
  expect(result).not.toHaveProperty('count_relation');
  expect(result.next === null || (typeof result.next === 'string' && result.next.length > 0)).toBe(true);
  expect(result.as_of).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/);
  expect(Number.isFinite(Date.parse(result.as_of))).toBe(true);
  expect(Date.parse(result.as_of)).toBeLessThanOrEqual(Date.now());
  return result;
}
async function create(labels: Labels, type = 'schema:Book') {
  const response = await driver!.request(
    'editor',
    'POST',
    '/v1/subjects',
    { type, labels },
    { 'Idempotency-Key': `"${randomUUID()}"` },
  );
  expect(response.status).toBe(201);
  const subject = response.body.subject as Subject;
  expect(subject.context).toBe(driver!.globalContext);
  expect(subject.labels).toEqual(labels);
  expect(response.headers.get('location')).toBe(`/v1/subjects/${subject.id}`);
  expect(response.headers.get('etag')).toBe('"1"');
  expect(response.headers.get('rezics-session-token')).toBeTruthy();
  return subject;
}
async function fixtures() {
  // Seven public subjects; no vote commands, so every rating score is null.
  const alpha = await create({ en: `${marker} Alpha` });
  const tie = await create({ en: `${marker} Alpha` });
  // The first language determines name_sort; ASCII case folding puts bETA
  // before Gamma even though its English display label is Zulu.
  const beta = await create({ en: `${marker} Zulu`, aa: `${marker} bETA` });
  const gamma = await create({ en: `${marker} Gamma` });
  const omega = await create({ en: `${marker} Omega` });
  const person = await create({ en: `${marker} Alpha` }, 'schema:Person');
  const outside = await create({ en: `${marker}outside Alpha` });
  const all = [alpha, tie, beta, gamma, omega, person, outside];
  // Bound readiness to 60 HTTP reads. Use existing name admission to distinguish
  // projection/composition failure from missing rating admission.
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    const indexed = page(await search({ text: `${marker} | ${marker}outside`, sort: 'name', limit: 100 }), 100);
    if (all.every((subject) => indexed.subjects.some((item) => item.id === subject.id))) {
      ready = true;
      break;
    }
    await Bun.sleep(250);
  }
  expect(ready).toBe(true);
  const ties = [alpha, tie].sort((a, b) => (a.id < b.id ? -1 : 1));
  return [...ties, beta, gamma, omega];
}
async function enumerate(expected: Subject[], persona: Persona = 'anonymous') {
  const subjects: Hit[] = [];
  let cursor: string | null = null;
  // At most three keyset pages for this fixed five-subject fixture.
  for (let index = 0; index < Math.ceil(expected.length / 2); index++) {
    const result = page(await search({ ...query(), ...(cursor === null ? {} : { cursor }) }, persona));
    expect(result.subjects).toEqual(expected.slice(index * 2, index * 2 + 2).map(hit));
    subjects.push(...result.subjects);
    cursor = result.next;
    if (index < Math.ceil(expected.length / 2) - 1) expect(typeof cursor).toBe('string');
  }
  expect(cursor).toBeNull();
  expect(subjects).toEqual(expected.map(hit));
  expect(new Set(subjects.map((subject) => subject.id)).size).toBe(expected.length);
}

test('Global rating null ties page by normalized name then id for anonymous and editor; suspended fails', async () => {
  const expected = await fixtures();
  for (const persona of ['anonymous', 'editor'] as const) await enumerate(expected, persona);
  problem(await search(query(), 'suspended'), 401, 'invalid_credentials');
});

test('Real signed rating cursors bind the entire request and principal and reject a reconciled generation change', async () => {
  const expected = await fixtures();
  const first = page(await search(query()));
  expect(first.subjects).toEqual(expected.slice(0, 2).map(hit));
  expect(typeof first.next).toBe('string');
  const token = first.next!;
  const tampered = `${token[0] === 'A' ? 'B' : 'A'}${token.slice(1)}`;
  for (const change of [
    { cursor: tampered },
    { limit: 3 },
    { text: `${marker} changed` },
    { filter: typeFilter('schema:Person') },
    { sort: 'name' },
  ]) {
    field(await search({ ...query(), cursor: token, ...change }), '/cursor');
  }
  field(await search({ ...query(), cursor: token }, 'editor'), '/cursor');
  // A real continuation succeeds before a real replay/reconciliation/alias swap.
  expect(page(await search({ ...query(), cursor: token })).subjects).toEqual(expected.slice(2, 4).map(hit));
  const rebuilt = await driver!.rebuild();
  expect(Number.isInteger(rebuilt.generation)).toBe(true);
  problem(await search({ ...query(), cursor: token }), 409, 'search_restart_required');
  await enumerate(expected);
});

test('Current hide and takedown suppress stale rating hits and refill pages with Search paused', async () => {
  const expected = await fixtures();
  const first = page(await search(query()));
  expect(first.subjects).toEqual(expected.slice(0, 2).map(hit));
  expect(typeof first.next).toBe('string');
  await driver!.indexing('paused');
  try {
    const taken = expected[0]!;
    const hidden = expected[2]!;
    await driver!.remove(taken.id, 'taken_down');
    await driver!.remove(hidden.id, 'hidden');
    const survivors = expected.filter((subject) => subject !== taken && subject !== hidden);
    for (const persona of ['anonymous', 'editor'] as const) {
      await enumerate(survivors, persona);
      for (const removed of [taken, hidden]) {
        problem(await driver!.request(persona, 'GET', `/v1/subjects/${removed.id}`), 404, 'not_found');
      }
    }
    const continuation = page(await search({ ...query(), cursor: first.next }));
    expect(continuation.subjects).toEqual(expected.slice(3).map(hit));
    expect(continuation.next).toBeNull();
  } finally {
    await driver!.indexing('running');
  }
});

test('Global rating search rejects internal population and question overrides as unknown fields', async () => {
  for (const persona of ['anonymous', 'editor'] as const) {
    for (const [key, value] of [
      ['populationId', randomUUID()],
      ['question', randomUUID()],
    ] as const) {
      field(await search({ ...query(), [key]: value }, persona), `/${key}`);
    }
  }
});
