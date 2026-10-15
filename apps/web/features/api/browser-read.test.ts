import { expect, test } from 'bun:test';
import { browserMainApi } from './browser.ts';

const work = '00000000-0000-4000-8000-000000000001';
const actingSubject = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';

test('a browser progress read recovers a lost transport with the identical actor and credentials', async () => {
  const requests: Request[] = [];
  const fetcher = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(input, init));
    if (requests.length === 1) throw new TypeError('Failed to fetch');
    return Response.json({ standing: 'started', version: 2 });
  }, { preconnect: fetch.preconnect });
  const main = browserMainApi('https://recorded.invalid', { fetcher });
  const answer = await main.v1.works({ id: work }).progress.get({ query: { actingSubject } });
  expect(answer.error).toBeNull();
  expect(answer.data).toMatchObject({ standing: 'started', version: 2 });
  expect(requests).toHaveLength(2);
  expect(requests[1]!.url).toBe(requests[0]!.url);
  expect(new URL(requests[1]!.url).searchParams.get('actingSubject')).toBe(actingSubject);
  expect(requests.map(request => request.credentials)).toEqual(['same-origin', 'same-origin']);
});

test('an HTTP refusal to a browser read is returned without another request', async () => {
  let calls = 0;
  const main = browserMainApi('https://recorded.invalid', { fetcher: Object.assign(async () => {
    calls++;
    return Response.json({ code: 'refused' }, { status: 503 });
  }, { preconnect: fetch.preconnect }) });
  const answer = await main.v1.works({ id: work }).progress.get({ query: { actingSubject } });
  expect(answer.error?.status).toBe(503);
  expect(calls).toBe(1);
});

test('a lost browser write response stays with its command owner', async () => {
  let calls = 0;
  const main = browserMainApi('https://recorded.invalid', { fetcher: Object.assign(async () => {
    calls++;
    throw new TypeError('Failed to fetch');
  }, { preconnect: fetch.preconnect }) });
  const answer = await main.v1.works({ id: work })['reader-status'].put({ actingSubject, expectedVersion: 1, status: 'reading' },
    { headers: { 'idempotency-key': 'exact-command' } });
  expect(answer.error?.status).toBe(503);
  expect(calls).toBe(1);
});

test('a persistently lost browser read stops after one retry', async () => {
  let calls = 0;
  const main = browserMainApi('https://recorded.invalid', { fetcher: Object.assign(async () => {
    calls++;
    throw new TypeError('Failed to fetch');
  }, { preconnect: fetch.preconnect }) });
  const answer = await main.v1.works({ id: work }).progress.get({ query: { actingSubject } });
  expect(answer.error?.status).toBe(503);
  expect(calls).toBe(2);
});
