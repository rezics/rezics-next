import { afterEach, expect, test } from 'bun:test';
import type { AnswerRecord, AnswerSample } from '../../../../scripts/api/answer-record.ts';
import books from '../../../../tests/qa/fixtures/outcomes/books/catalogue-browse-and-search-in-its-zone.json';
import hub from '../../../../tests/qa/fixtures/outcomes/books/work-hub-and-edition-choice.json';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { mainApiWithToken } from '../api/main.ts';
import { recordedFetch, type RecordedSelection } from './recorded-fetch.ts';

const bookRecord = books as AnswerRecord;
const populated = bookRecord.personas.visitor.find(sample => sample.label === 'browse-newest-0')!;
const empty = bookRecord.personas.visitor.find(sample => sample.label === 'search-no-match')!;
const problem = bookRecord.personas.visitor.find(sample => sample.label === 'unsupported-query-shape')!;
const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });

test('a recorded public header with a bare question mark has the same empty query as the typed client', async () => {
  const record = hub as AnswerRecord;
  const sample = record.personas.visitor.find(value => value.label === 'work-header')!;
  const { fetcher, dispose } = recordedFetch(record, 'visitor', [{ label: sample.label, state: 'populated' }],
    { pathPrefix: BFF_PREFIX });
  disposals.push(dispose);
  const main = browserMainApi('https://recorded.invalid', { anonymous: true, fetcher });
  const id = new URL(sample.path, 'https://recorded.invalid').pathname.split('/').at(-1)!;
  const answer = await main.v1.works({ id }).get({ query: { actingSubject: undefined } });
  expect(answer.error).toBeNull();
  expect(answer.data).toEqual(sample.answer);
});
function replay(record: AnswerRecord, selections: RecordedSelection[], pathPrefix = '') {
  const result = recordedFetch(record, 'visitor', selections, { pathPrefix });
  disposals.push(result.dispose);
  return result;
}
function recordWith(...samples: AnswerSample[]): AnswerRecord {
  return { version: 1, row: 'transport-test', personas: {
    visitor: samples, stranger: [], member: [], owner: [], moderator: [], operator: [],
  } };
}

test('a query matches by its parameters in any order; one name\'s repeated values keep theirs', async () => {
  const sample: AnswerSample = { label: 'list', operationId: 'transport', method: 'GET',
    path: '/v1/transport?limit=20&type=a&type=b&actingSubject=person%3A1',
    status: 200, headers: { 'content-type': 'application/json' }, answer: { items: [] } };
  const { fetcher } = replay(recordWith(sample), [{ label: 'list', state: 'populated' }]);
  const response = await fetcher('https://offline.invalid/v1/transport?actingSubject=person:1&type=a&limit=20&type=b');
  expect(await response.json()).toEqual(sample.answer);
  await expect(fetcher('https://offline.invalid/v1/transport?actingSubject=person:1&type=b&limit=20&type=a'))
    .rejects.toThrow('Unmatched recorded request');
  expect(() => replay(recordWith(sample, { ...sample, label: 'again', path: '/v1/transport?type=a&type=b&limit=20&actingSubject=person%3A1' }),
    [{ label: 'list', state: 'populated' }, { label: 'again', state: 'populated' }])).toThrow('Ambiguous recorded request');
});

test('matches the method, path, query parameters and JSON body and prints any unmatched request', async () => {
  const sample: AnswerSample = { label: 'command', operationId: 'transport', method: 'POST',
    path: '/v1/transport?first=1&second=2', body: { nested: { yes: true }, list: [1, 2] },
    status: 200, headers: { 'content-type': 'application/json', etag: 'opaque' }, answer: { accepted: true } };
  const { fetcher } = replay(recordWith(sample), [{ label: 'command', state: 'populated' }]);
  const request = new Request(`https://offline.invalid${sample.path}`, {
    method: 'POST', body: JSON.stringify({ list: [1, 2], nested: { yes: true } }),
  });
  const response = await fetcher(request);
  expect(response.status).toBe(200);
  expect(response.headers.get('etag')).toBe('opaque');
  expect(await response.json()).toEqual(sample.answer);
  expect(await request.json()).toEqual(sample.body);
  for (const [method, path, body] of [
    ['PUT', sample.path, sample.body],
    ['POST', '/v1/other?first=1&second=2', sample.body],
    ['POST', '/v1/transport?first=1&second=2&extra=3', sample.body],
    ['POST', sample.path, { nested: { yes: false }, list: [1, 2] }],
    ['POST', sample.path, { nested: { yes: true }, list: [2, 1] }],
    ['POST', sample.path, undefined],
  ] as const) {
    const printed = JSON.stringify({ method, path, body: body === undefined ? '<absent>' : body });
    await expect(fetcher(`https://offline.invalid${path}`, { method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })).rejects.toThrow(printed);
  }
});

test('replays recorded populated, empty and problem answers without rewriting them', async () => {
  const { fetcher } = replay(bookRecord, [
    { label: populated.label, state: 'populated' },
    { label: empty.label, state: 'empty' },
    { label: problem.label, state: 'error' },
  ]);
  for (const sample of [populated, empty, problem]) {
    const response = await fetcher(`https://offline.invalid${sample.path}`);
    expect(response.status).toBe(sample.status);
    expect(Object.fromEntries(response.headers)).toEqual(sample.headers);
    expect(await response.json()).toEqual(sample.answer);
  }
  // Each call gets its own response body; there is no consumption counter or cache.
  expect(await (await fetcher(`https://another.invalid${populated.path}`)).json()).toEqual(populated.answer);
});

test('pending is a recorded 202, including its headers and answer', async () => {
  const sample: AnswerSample = { label: 'accepted', operationId: 'transport', method: 'POST',
    path: '/v1/transport', body: null, status: 202,
    headers: { 'content-type': 'application/json', location: '/v1/jobs/opaque', 'retry-after': '3' },
    answer: { job: 'opaque' } };
  const { fetcher } = replay(recordWith(sample), [{ label: 'accepted', state: 'pending' }]);
  const response = await fetcher(`https://offline.invalid${sample.path}`, { method: 'POST', body: 'null' });
  expect(response.status).toBe(202);
  expect(Object.fromEntries(response.headers)).toEqual(sample.headers);
  expect(await response.json()).toEqual(sample.answer);
  await expect(fetcher(`https://offline.invalid${sample.path}`, { method: 'POST' })).rejects.toThrow('Unmatched');
});

test('a completed create or removal supplies a populated state, never a pending one', async () => {
  const created: AnswerSample = { label: 'created', operationId: 'transport', method: 'POST',
    path: '/v1/transport', body: { title: 'one' }, status: 201,
    headers: { 'content-type': 'application/json', location: '/v1/transport/opaque' }, answer: { id: 'opaque' } };
  const removed: AnswerSample = { label: 'removed', operationId: 'transport', method: 'DELETE',
    path: '/v1/transport/opaque', status: 204, headers: {}, answer: null };
  const record = recordWith(created, removed);
  const { fetcher } = replay(record, [{ label: 'created', state: 'populated' }, { label: 'removed', state: 'empty' }]);
  const response = await fetcher(`https://offline.invalid${created.path}`, { method: 'POST', body: JSON.stringify(created.body) });
  expect(response.status).toBe(201);
  expect(response.headers.get('location')).toBe('/v1/transport/opaque');
  expect(await response.json()).toEqual(created.answer);
  const gone = await fetcher(`https://offline.invalid${removed.path}`, { method: 'DELETE' });
  expect(gone.status).toBe(204);
  expect(await gone.text()).toBe('');
  for (const label of ['created', 'removed']) {
    expect(() => recordedFetch(record, 'visitor', [{ label, state: 'pending' }])).toThrow('cannot supply');
  }
});

test('an unrecorded state, label, persona or ambiguous request cannot be selected', () => {
  for (const state of ['pending', 'error'] as const) {
    expect(() => recordedFetch(bookRecord, 'visitor', [{ label: populated.label, state }])).toThrow('cannot supply');
  }
  expect(() => recordedFetch(bookRecord, 'visitor', [{ label: problem.label, state: 'empty' }])).toThrow('cannot supply');
  expect(() => recordedFetch(bookRecord, 'visitor', [{ label: 'absent', state: 'empty' }])).toThrow('Expected one');
  expect(() => recordedFetch(recordWith(populated), 'member', [{ label: populated.label, state: 'populated' }])).toThrow('Expected one');
  expect(() => recordedFetch(recordWith(populated, populated), 'visitor', [{ label: populated.label, state: 'populated' }])).toThrow('Expected one');
  expect(() => recordedFetch(recordWith(populated, { ...populated, label: 'other' }), 'visitor', [
    { label: populated.label, state: 'populated' }, { label: 'other', state: 'loading' },
  ])).toThrow('Ambiguous');
});

test('loading holds every matching call, then story disposal releases all and closes the transport', async () => {
  const { fetcher, dispose } = replay(bookRecord, [{ label: populated.label, state: 'loading' }]);
  let settled = 0;
  const calls = Array.from({ length: 2 }, () => fetcher(`https://offline.invalid${populated.path}`)
    .then(() => { settled++; return 'answered'; }, error => { settled++; return error as Error; }));
  await expect(fetcher('https://offline.invalid/unknown')).rejects.toThrow('Unmatched');
  expect(settled).toBe(0);
  dispose();
  for (const result of await Promise.all(calls)) expect(result).toMatchObject({ name: 'AbortError' });
  expect(settled).toBe(2);
  dispose();
  await expect(fetcher(`https://offline.invalid${populated.path}`)).rejects.toMatchObject({ name: 'AbortError' });
});

test('loading respects both caller cancellation and an already aborted request', async () => {
  const { fetcher } = replay(bookRecord, [{ label: populated.label, state: 'loading' }]);
  const controller = new AbortController();
  const pending = fetcher(`https://offline.invalid${populated.path}`, { signal: controller.signal });
  await expect(fetcher('https://offline.invalid/unknown')).rejects.toThrow('Unmatched');
  const reason = new DOMException('Reader left', 'AbortError');
  const outcome = pending.catch((error: unknown) => error);
  controller.abort(reason);
  expect(await outcome).toBe(reason);
  await expect(fetcher(`https://offline.invalid${populated.path}`, { signal: controller.signal }))
    .rejects.toMatchObject({ name: 'AbortError' });
});

test('the real browser and server typed clients accept the per-story fetch', async () => {
  const browser = replay(bookRecord, [{ label: populated.label, state: 'populated' }], BFF_PREFIX);
  const server = replay(bookRecord, [{ label: populated.label, state: 'populated' }]);
  const realm = new URL(`https://offline.invalid${populated.path}`).pathname.split('/')[3]!;
  const query = { sort: 'newest' as const, limit: 10, type: ['https://schema.org/Book'] };
  const replies = await Promise.all([
    browserMainApi('https://offline.invalid', { fetcher: browser.fetcher }).v1.realms({ realm }).modules.browse.get({ query }),
    mainApiWithToken(undefined, { fetcher: server.fetcher }).v1.realms({ realm }).modules.browse.get({ query }),
  ]);
  for (const reply of replies) {
    expect(reply.error).toBeNull();
    expect(reply.data as unknown).toEqual(populated.answer);
  }
});

test('two stories on the same page own distinct fetches, answers and disposal', async () => {
  const loading = replay(bookRecord, [{ label: populated.label, state: 'loading' }], BFF_PREFIX);
  const ready = replay(bookRecord, [{ label: populated.label, state: 'populated' }], BFF_PREFIX);
  expect(loading.fetcher).not.toBe(ready.fetcher);
  const request = `https://same-page.invalid${BFF_PREFIX}${populated.path}`;
  let settled = false;
  const held = loading.fetcher(request).catch(error => { settled = true; return error as Error; });
  expect(await (await ready.fetcher(request)).json()).toEqual(populated.answer);
  expect(settled).toBe(false);
  loading.dispose();
  expect(await held).toMatchObject({ name: 'AbortError' });
  expect(await (await ready.fetcher(request)).json()).toEqual(populated.answer);
  await expect(ready.fetcher(`https://same-page.invalid/api/other${populated.path}`)).rejects.toThrow('Unmatched');
});
