import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  parseSelection,
  parseStatus,
  readErasureStatus,
  type ErasureStatus,
  type Page,
} from '../src/accounts/erasure-progress/data';
import { ErasureReader } from '../src/accounts/erasure-progress/reader';
import { ErasureProgressView } from '../src/accounts/erasure-progress/view';
import { m } from '../src/paraglide/messages.js';

const accountId = '019a0000-0000-7000-8000-000000000001';
const viewerId = '019a0000-0000-7000-8000-000000000002';
const selection = { accountId, viewerId };
const at = '2026-10-01T10:00:00.000Z';
const completedAt = '2026-10-02T10:00:00.000Z';
const pending = (): ErasureStatus => ({
  accountId,
  state: 'pending',
  at,
  completedAt: null,
  pendingParticipants: ['auth', 'shared-history'],
  retentionOutstanding: false,
  lateItems: true,
  effectsFrontier: true,
});
const ready = (value = pending()): Page => ({ status: 'ready', viewerId, value });
const html = (page: Page) => renderToStaticMarkup(createElement(ErasureProgressView, { page }));

test('private platform erasure progress shows exact native pending retention and completion without inferring success from unavailable or missing participant proof', async () => {
  let body: unknown = pending();
  let status = 200;
  const requests: Request[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    requests.push(new Request(input, init));
    return Response.json(body, { status });
  };
  const read = () =>
    readErasureStatus('https://kernel.example.test', 'Bearer current-native-scope', selection, fetcher);
  const first = await read();
  expect(first).toEqual(ready());
  expect(html(first)).toContain(m.erasure_pending());
  expect(html(first)).toContain('shared-history');
  expect(html(first)).toContain(`dateTime="${at}"`);
  expect(html(first)).toContain(m.erasure_not_reported());
  expect(html(first)).toContain(m.erasure_late_yes());
  expect(html(first)).toContain(m.erasure_frontier_yes());
  expect(html(first)).not.toContain('<progress');
  expect(html(first)).not.toContain('<form');
  expect(html(first)).not.toContain('role="progressbar"');
  const retention: ErasureStatus = {
    ...pending(),
    state: 'retention-outstanding',
    completedAt,
    pendingParticipants: [],
    retentionOutstanding: true,
    lateItems: false,
    effectsFrontier: false,
  };
  body = retention;
  const retained = await read();
  expect(retained).toEqual(ready(retention));
  expect(html(retained)).toContain(m.erasure_retention_help());
  expect(html(retained)).toContain(`dateTime="${completedAt}"`);
  expect(html(retained)).not.toContain(`<h2>${m.erasure_complete()}</h2>`);
  body = { ...retention, state: 'complete', retentionOutstanding: false };
  const complete = await read();
  expect(complete.status).toBe('ready');
  expect(html(complete)).toContain(`<h2>${m.erasure_complete()}</h2>`);
  expect(html(complete)).toContain(m.erasure_complete_help());

  // No names, no queued work and false flags never upgrade a native pending observation.
  const unknownProof = { ...pending(), pendingParticipants: [], lateItems: false, effectsFrontier: false };
  body = unknownProof;
  const unknown = await read();
  expect(unknown).toEqual(ready(unknownProof));
  expect(html(unknown)).toContain(m.erasure_pending_help());
  expect(html(unknown)).toContain(m.erasure_no_pending_names());
  expect(html(unknown)).toContain(m.erasure_frontier_no());
  for (const code of [401, 403, 404, 202, 503]) {
    status = code;
    body = { ...pending(), secret: 'private reason, store and locator' };
    const failure = await read();
    expect(failure).toEqual({
      status: code === 401 ? 'signed-out' : code === 403 ? 'denied' : code === 404 ? 'missing' : 'unavailable',
    });
    expect(html(failure)).not.toContain(accountId);
    expect(html(failure)).not.toContain('shared-history');
    expect(html(failure)).not.toContain('private reason');
    expect(html(failure)).not.toContain(`<h2>${m.erasure_complete()}</h2>`);
  }
  for (const request of requests) {
    expect(request.method).toBe('GET');
    expect(request.url).toBe(`https://kernel.example.test/v1/accounts/${accountId}/erasureStatus`);
    expect(request.body).toBeNull();
    expect(request.headers.get('authorization')).toBe('Bearer current-native-scope');
    expect(request.headers.get('cache-control')).toBe('no-store');
    expect(request.cache).toBe('no-store');
    expect(request.redirect).toBe('error');
  }
});

test('closed native allowlist rejects omitted, private, unknown and contradictory observations without guessing proof', async () => {
  const { effectsFrontier: _missing, ...omitted } = pending();
  const malformed: unknown[] = [
    null,
    [],
    {},
    omitted,
    { ...pending(), accountId: viewerId },
    { ...pending(), stores: ['private-store'] },
    { ...pending(), state: 'queued' },
    { ...pending(), state: 'complete' },
    { ...pending(), completedAt },
    { ...pending(), state: 'retention-outstanding' },
    { ...pending(), effectsFrontier: null },
    { ...pending(), lateItems: 'false' },
    { ...pending(), pendingParticipants: null },
    { ...pending(), pendingParticipants: ['auth', 'auth'] },
    { ...pending(), pendingParticipants: ['secret/store?token=secret'] },
    { ...pending(), pendingParticipants: ['x'.repeat(65)] },
    { ...pending(), pendingParticipants: Array.from({ length: 65 }, (_, n) => `participant-${n}`) },
    { ...pending(), at: '2026-02-30T10:00:00.000Z' },
    {
      ...pending(),
      state: 'complete',
      completedAt: '2026-09-01T10:00:00.000Z',
      pendingParticipants: [],
      lateItems: false,
      effectsFrontier: false,
    },
  ];
  for (const value of malformed) expect(parseStatus(value, accountId)).toBeNull();
  for (const value of [undefined, accountId, { accountId, viewerId, role: 'admin' }, { accountId: 'handle', viewerId }])
    expect(() => parseSelection(value)).toThrow();
  let calls = 0;
  const never: typeof fetch = async () => {
    calls++;
    throw new Error('must not fetch');
  };
  expect(await readErasureStatus(undefined, 'Bearer viewer', selection, never)).toEqual({ status: 'unavailable' });
  expect(calls).toBe(0);
  for (const response of [
    new Response('not JSON', { headers: { 'content-type': 'text/html' } }),
    new Response('{broken', { headers: { 'content-type': 'application/json' } }),
    new Response(' '.repeat(16_385), { headers: { 'content-type': 'application/json' } }),
    Response.json(omitted),
  ])
    expect(
      await readErasureStatus('https://kernel.example.test', 'Bearer viewer', selection, async () => response),
    ).toEqual({ status: 'unavailable' });
  expect(
    await readErasureStatus('https://kernel.example.test', 'Bearer viewer', selection, async () => {
      throw new Error('private upstream error');
    }),
  ).toEqual({ status: 'unavailable' });
});

test('explicit reload replaces sensitive observations and discards stale results after denial, signout or viewer changes', async () => {
  const replies: ((page: Page) => void)[] = [];
  const reader = new ErasureReader(selection, () => new Promise((resolve) => replies.push(resolve)));
  const first = reader.reload();
  replies[0]!(ready());
  await first;
  expect(html(reader.snapshot())).toContain(accountId);
  const slow = reader.reload();
  expect(reader.snapshot()).toEqual({ status: 'loading' });
  expect(html(reader.snapshot())).not.toContain(accountId);
  const denial = reader.reload();
  replies[2]!({ status: 'denied' });
  await denial;
  replies[1]!(ready());
  await slow;
  expect(reader.snapshot()).toEqual({ status: 'denied' });
  const oldSession = reader.reload();
  reader.clear();
  replies[3]!(ready());
  await oldSession;
  expect(reader.snapshot()).toEqual({ status: 'loading' });
  const foreign = reader.reload();
  replies[4]!({ status: 'ready', viewerId: accountId, value: pending() });
  await foreign;
  expect(reader.snapshot()).toEqual({ status: 'unavailable' });
  for (const status of ['signed-out', 'unavailable', 'missing'] as const) {
    const reload = reader.reload();
    replies.at(-1)!({ status });
    await reload;
    expect(reader.snapshot()).toEqual({ status });
    expect(html(reader.snapshot())).not.toContain(accountId);
  }
  expect(replies).toHaveLength(8); // only explicit calls, no timer or background recovery
});
