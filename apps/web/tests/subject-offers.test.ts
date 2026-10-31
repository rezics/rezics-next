import { expect, mock, spyOn, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { subjectOfferFixture } from '../src/kernel/fake/subject-offers';
import otherSubject from '../src/kernel/recorded/subject-uncovered.json';
import type { SubjectOffersInput, SubjectOffersPage } from '../src/checkout/subject-offers';

let request = new Request('https://site.test/en');
mock.module('cloudflare:workers', () => ({ env: { KERNEL_ORIGIN: 'https://kernel.test' } }));
mock.module('@tanstack/react-start/server', () => ({
  getRequest: () => request,
  setResponseHeader: () => {},
  setResponseStatus: () => {},
}));
const { createNativeSubjectOffersApi, loadSubjectOffers, nativeSubjectOffersApi, parseSubjectOffersPage } =
  await import('../src/checkout/subject-offers');
const { acceptLanguage } = await import('../src/kernel/client');

const subjectId = subjectOfferFixture.targetSubjectId;
const authorization = 'Bearer current-reader';
const input: SubjectOffersInput = { subjectId, locale: 'zh-Hant', credentialMode: 'session' };
// Reuse the existing illustrative public wire. These transport cases are not native recordings or sale proof.
const page: SubjectOffersPage = {
  offers: [subjectOfferFixture],
  next: 'opaque-signed-native-cursor+/=',
  projectionState: 'ready',
};
function reader(credential: string | null = authorization) {
  request = new Request('https://site.test/zh-Hant', {
    headers: credential ? { authorization: credential } : {},
  });
  return request;
}

test('A subject shopper can discover actual current native offers through the delivered API rather than an unconditional unavailable adapter', async () => {
  const calls: Request[] = [];
  const fetcher = spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    calls.push(new Request(url, init));
    return Response.json(page, { headers: { 'cache-control': 'private, no-store' } });
  });
  try {
    const result = await loadSubjectOffers(nativeSubjectOffersApi, reader(), {}, input);
    expect(result).toEqual({ kind: 'ready', ...page });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    const url = new URL(call.url);
    expect(url.origin).toBe('https://kernel.test');
    expect(url.pathname).toBe(`/v1/subjects/${subjectId}/offers`);
    expect([...url.searchParams]).toEqual([['limit', '10']]);
    expect(call.method).toBe('GET');
    expect(call.cache).toBe('no-store');
    expect(call.redirect).toBe('manual');
    expect(call.headers.get('authorization')).toBe(authorization);
    expect(call.headers.get('accept-language')).toBe(acceptLanguage(input.locale));
    expect(call.headers.get('cookie')).toBeNull();
    expect(call.headers.get('idempotency-key')).toBeNull();
    expect(JSON.stringify(result)).not.toContain(authorization);

    await loadSubjectOffers(nativeSubjectOffersApi, reader(), {}, { ...input, cursor: page.next! });
    expect(calls).toHaveLength(2);
    expect(new URL(calls[1]!.url).searchParams.get('cursor')).toBe(page.next);
    expect(new URL(calls[1]!.url).searchParams.get('limit')).toBe('10');
  } finally {
    fetcher.mockRestore();
  }
});

test('the bound native directory preserves sparse continuation, preparing positives, refusal and genuine unavailability', async () => {
  const responses = [
    Response.json({ ...page, offers: [] }),
    Response.json({ ...page, projectionState: 'preparing' }),
    Response.json({ code: 'scope_required' }, { status: 401 }),
    Response.json({ code: 'forbidden' }, { status: 403 }),
    Response.json({ code: 'not_found' }, { status: 404 }),
    Response.json({ code: 'stale_cursor' }, { status: 409 }),
    Response.json({ code: 'invalid_cursor' }, { status: 400 }),
    Response.json({ code: 'dependency_unavailable' }, { status: 503 }),
    Response.json(null),
  ];
  let reads = 0;
  const fetcher = spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    reads++;
    expect(new Request(url, init).headers.get('authorization')).toBe(authorization);
    const response = responses.shift();
    if (!response) throw new Error('Unexpected directory retry or per-card lookup');
    return response;
  });
  try {
    for (const [index, expected] of [
      { kind: 'ready', ...page, offers: [] },
      { kind: 'ready', ...page, projectionState: 'preparing' },
      { kind: 'denied', status: 401, code: 'scope_required' },
      { kind: 'denied', status: 403, code: 'forbidden' },
      { kind: 'denied', status: 404, code: 'not_found' },
      { kind: 'cursor-error' },
      { kind: 'cursor-error' },
      { kind: 'unavailable' },
      { kind: 'unavailable' },
    ].entries()) {
      expect(await loadSubjectOffers(nativeSubjectOffersApi, reader(), {}, input)).toEqual(expected);
      expect(reads).toBe(index + 1);
    }
  } finally {
    fetcher.mockRestore();
  }
});

test('the existing generated client retains session tokens and anonymous reads send no credential', async () => {
  const calls: Request[] = [];
  const client = createKernelClient('https://kernel.test', {
    session: 'existing-reader-session',
    fetch: async (url, init) => {
      calls.push(new Request(url, init));
      return Response.json(page, { headers: { 'rezics-session-token': 'next-reader-session' } });
    },
  });
  const api = createNativeSubjectOffersApi(client);
  const anonymous: SubjectOffersInput = { ...input, credentialMode: 'anonymous' };
  expect(await loadSubjectOffers(api, reader(null), {}, anonymous)).toEqual({ kind: 'ready', ...page });
  expect(await loadSubjectOffers(api, reader(null), {}, { ...anonymous, cursor: page.next! })).toEqual({
    kind: 'ready',
    ...page,
  });
  expect(calls).toHaveLength(2);
  expect(calls[0]!.headers.get('rezics-session-token')).toBe('existing-reader-session');
  expect(calls[1]!.headers.get('rezics-session-token')).toBe('next-reader-session');
  expect(calls.every((call) => !call.headers.has('authorization') && call.method === 'GET')).toBe(true);

  expect(await loadSubjectOffers(api, reader(null), {}, input)).toEqual({ kind: 'denied', status: 401, code: null });
  expect(calls).toHaveLength(2);
});

test('native original targets and captured versions stay intact, while malformed and private fields fail closed', () => {
  // The directory, rather than Web identity lookups, confirms membership for an original/terminal request.
  expect(parseSubjectOffersPage(page, otherSubject.subject.id)).toEqual(page);
  const terms = subjectOfferFixture.contentEdition!;
  for (const offers of [
    [{ ...subjectOfferFixture, targetSubjectId: otherSubject.subject.id }],
    [{ ...subjectOfferFixture, targetSubjectId: 'malformed' }],
    [{ ...subjectOfferFixture, contentEdition: { ...terms, quantity: 2 } }],
    [{ ...subjectOfferFixture, contentEdition: { ...terms, benefit: { ...terms.benefit, action: 'subject:read' } } }],
    [{ ...subjectOfferFixture, contentEdition: { ...terms, benefit: { ...terms.benefit, version: null } } }],
    [{ ...subjectOfferFixture, contentEdition: { ...terms, source: { ...terms.source, body: 'private' } } }],
    [{ ...subjectOfferFixture, owned: true }],
    [{ ...subjectOfferFixture, revision: 0 }],
    Array(11).fill(subjectOfferFixture),
    [subjectOfferFixture, subjectOfferFixture],
  ])
    expect(parseSubjectOffersPage({ ...page, offers }, subjectId)).toBeNull();
  expect(parseSubjectOffersPage({ ...page, count: 1 }, subjectId)).toBeNull();
  expect(parseSubjectOffersPage({ ...page, next: 'x'.repeat(4097) }, subjectId)).toBeNull();
  const unknown = { ...subjectOfferFixture, moneyUnit: null, taxBehavior: null, contentEdition: null };
  expect(parseSubjectOffersPage({ ...page, offers: [unknown] }, subjectId)?.offers).toEqual([unknown]);
});

test('transport failure and platform closure cannot become empty discovery or an anonymous fallback', async () => {
  let reads = 0;
  const fetcher = spyOn(globalThis, 'fetch').mockImplementation(async () => {
    reads++;
    if (reads === 1) throw new TypeError('Directory transport unavailable');
    return Response.json({ code: 'platform_closed' }, { status: 403 });
  });
  try {
    expect(await loadSubjectOffers(nativeSubjectOffersApi, reader(), {}, input)).toEqual({ kind: 'unavailable' });
    await expect(loadSubjectOffers(nativeSubjectOffersApi, reader(), {}, input)).rejects.toMatchObject({
      name: 'PlatformClosedError',
    });
    expect(reads).toBe(2);
  } finally {
    fetcher.mockRestore();
  }
});
