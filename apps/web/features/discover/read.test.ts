import { expect, test } from 'bun:test';
import { browserMainApi } from '../api/browser.ts';
import { discoveryApi } from './api.ts';
import { readBrowse } from './browse-read.ts';
import { settle, readDiscovery } from './read.ts';
import { readQueryDiscovery } from './query-read.ts';
import { discoveryPagesOptions, ReadError } from './query.ts';
import type { DiscoveryPage } from './types.ts';

const problem = { type: 'https://rezics.com/problems/discovery-unavailable', title: 'Unavailable',
  status: 503, code: 'discovery_unavailable', detail: 'Projection recovery has not reached the selected cut.',
  currentHead: null, validation: { path: '/filter', constraint: 'supported' } };
const response = (status: number, body: unknown) => new Response(JSON.stringify(body),
  { status, headers: { 'content-type': 'application/json' } });

test('a discovery category retains the full HTTP status and problem, including unknown fields', async () => {
  const read = await settle(async () => ({ data: null, error: { status: 503, value: problem } }));
  expect(read).toEqual({ ok: false, failure: 'unbuilt', status: 503, problem });
});

test('only HTTP 202 means pending; ordinary 503 responses retain their refusal', async () => {
  const pending = { phase: 'preparing', ticket: 'opaque-ticket' };
  expect(await settle(async () => ({ data: pending, error: null, response: { status: 202 } })))
    .toEqual({ ok: false, failure: 'pending', status: 202, problem: pending });
  const main = browserMainApi('https://story.invalid', { anonymous: true,
    fetcher: (async (_input: RequestInfo | URL, _init?: RequestInit) => response(503, problem)) as typeof fetch });
  expect(await readDiscovery(main, { scope: 'global' })).toEqual({ ok: false, failure: 'unbuilt', status: 503, problem });
});

test('a moved first page is stale without losing evidence; cursor failures stay moved', async () => {
  const body = { ...problem, code: 'read_basis_changed', status: 409 };
  const main = browserMainApi('https://story.invalid', { anonymous: true,
    fetcher: (async (_input: RequestInfo | URL, _init?: RequestInit) => response(409, body)) as typeof fetch });
  expect(await readDiscovery(main, { scope: 'global' })).toEqual({ ok: false, failure: 'stale', status: 409, problem: body });
  expect(await readDiscovery(main, { scope: 'global', cursor: 'opaque' })).toEqual({ ok: false, failure: 'moved', status: 409, problem: body });
});

test('filtered discovery retries a moved first page once and preserves its final problem', async () => {
  let calls = 0;
  const body = { ...problem, status: 409, code: 'read_basis_changed' };
  const main = browserMainApi('https://story.invalid', { anonymous: true,
    fetcher: (async (_input: RequestInfo | URL, _init?: RequestInit) => { calls++; return response(409, body); }) as typeof fetch });
  const state = { scope: { kind: 'global' as const }, context: null, type: null, term: null,
    conditions: { include: ['00000000-0000-4000-8000-000000000001'], exclude: [], match: 'all' as const } };
  expect(await readQueryDiscovery(main, state, { scope: 'global' }))
    .toEqual({ ok: false, failure: 'moved', status: 409, problem: body });
  expect(calls).toBe(2);
});

test('resource discovery settles retain the original refusal and recognize accepted pending responses', async () => {
  for (const status of [202, 400, 404, 409, 503]) {
    const body = { ...problem, status };
    const main = browserMainApi('https://story.invalid', { anonymous: true,
      fetcher: (async (_input: RequestInfo | URL, _init?: RequestInit) => response(status, body)) as typeof fetch });
    const read = await readBrowse(() => discoveryApi(main, 'en').resources({ profile: 'resource-list-v1',
      context: 'global', scope: { kind: 'all' }, sort: 'newest' }));
    expect(read).toEqual({ ok: false, moved: status === 409, status, problem: body, ...(status === 202 ? { pending: true } : {}) });
  }
});

test('continuation errors carry the entire failed answer through query state', async () => {
  const first = { sourcePosition: { dataEpoch: 'fixture', sequence: '12' } } as DiscoveryPage;
  const options = discoveryPagesOptions({ scope: 'global' }, first,
    async () => ({ ok: false, failure: 'unbuilt', status: 503, problem }));
  const fn = options.queryFn;
  if (typeof fn !== 'function') throw new Error('Missing query function');
  try {
    await fn({ pageParam: 'opaque' } as Parameters<typeof fn>[0]);
    throw new Error('Expected a failed continuation');
  } catch (error) {
    expect(error).toBeInstanceOf(ReadError);
    expect((error as ReadError).response).toMatchObject({ status: 503, problem });
  }
});
