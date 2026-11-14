import { afterAll, beforeEach, expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import * as start from '../.storybook/react-start';
import { readConsumptionSummary, readDiaryPage, readReportedYearSummary } from '../src/library/private-diary/native';

const counts = (count = '0') => ({
  completedOccurrences: count,
  distinctCompletedSubjects: count,
  repeatOccurrences: '0',
  completedOccurrencesWithUnknownProfile: '0',
});
const summary = {
  ...counts('9007199254740993'),
  scope: 'retained_native_sessions',
  coverage: { nativeSessions: 'complete', otherHistory: 'unavailable', unitMeaning: 'not_evaluated' },
  currentness: { state: 'snapshot', revision: 'original-summary' },
};
const bucket = (count = '0') => ({ ...counts(count), finishPrecision: { year: count, month: '0', day: '0' } });
const yearSummary = {
  ...summary,
  ...bucket('9007199254740993'),
  year: 2020,
  calendar: 'gregorian',
  dateSource: 'explicitly_reported_journal_finish',
  months: Array.from({ length: 12 }, (_, i) => ({ ...bucket(), month: i + 1 })),
  monthUnallocated: bucket('9007199254740993'),
  coverage: {
    ...summary.coverage,
    initializedSessions: '9007199254740993',
    retainedSessions: '9007199254740993',
    completedOccurrencesWithMissingFinish: '0',
    completedOccurrencesWithUnsupportedFinish: '0',
  },
};
const page = {
  occurrences: [],
  order: 'recorded_started_desc_id_desc',
  next: 'opaque-next',
  continuation: 'original-continuation',
  expiresAt: '2026-11-15T00:00:00.000Z',
};
const headers = new Headers();
const calls: { url: URL; init: RequestInit }[] = [];
let request: Request;
let prepare: () => Promise<void>;
const success = (url: URL) =>
  Response.json(url.pathname.endsWith('libraryDiary') ? page : url.searchParams.has('year') ? yearSummary : summary);
let respond: (url: URL, init: RequestInit) => Promise<Response>;
const client = createKernelClient('https://kernel.test', {
  fetch: async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push({ url, init });
    return respond(url, init);
  },
});
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => ({
  getRequest: () => request,
  setResponseHeader: (name: string, value: string) => headers.set(name, value),
}));
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('../src/kernel/client', () => ({ kernelClient: () => client }));
mock.module('../src/library/subject-slot', () => ({
  readSubjectSlotSession: async (incoming: Request) => {
    expect(incoming).toBe(request);
    await prepare();
    return { state: 'signed-in', subject: 'owner', csrfToken: 'csrf', authorization: 'Bearer current' };
  },
}));
const { readPrivateDiary, cancelPrivateDiary } = await import('../src/library/private-diary/server');
beforeEach(() => {
  request = new Request('https://site.test/library/history');
  calls.length = 0;
  headers.delete('cache-control');
  prepare = async () => {};
  respond = async (url) => success(url);
});
afterAll(() => mock.restore());
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

test('one exact page of 25 and its selected summary use private, manual, request-bound native GETs', async () => {
  for (const address of [
    {},
    { year: 2020 },
    { year: 2020, month: 7 },
    {
      year: 2020,
      month: 'unallocated',
      cursor: 'opaque+/=&cursor',
    },
  ]) {
    calls.length = 0;
    const result = await readPrivateDiary({ data: address });
    expect(result).toMatchObject({
      kind: 'ready',
      address,
      viewer: 'owner',
      csrfToken: 'csrf',
      diary: { kind: 'ready', page },
    });
    expect(result).toMatchObject(
      'year' in address
        ? { summary: { kind: 'not-selected' }, reportedYear: { kind: 'ready', value: yearSummary } }
        : { summary: { kind: 'ready', value: summary }, reportedYear: null },
    );
    expect(calls.map(({ url }) => url.pathname)).toEqual([
      '/v1/libraryDiary',
      'year' in address ? '/v1/libraryReportedYearSummary' : '/v1/libraryConsumptionSummary',
    ]);
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({
      limit: '25',
      ...Object.fromEntries(Object.entries(address).map(([key, value]) => [key, String(value)])),
    });
    expect(Object.fromEntries(calls[1]!.url.searchParams)).toEqual('year' in address ? { year: '2020' } : {});
    for (const { init } of calls) {
      expect(init).toMatchObject({ method: 'GET', cache: 'no-store', redirect: 'manual' });
      expect(init.signal).toBe(request.signal);
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer current');
    }
    expect(headers.get('cache-control')).toBe('private, no-store');
  }
});

test('a refused, lost or redirected sibling preserves the other native result without retry or refill', async () => {
  for (const address of [{}, { year: 2020 }])
    for (const failed of ['diary', 'summary']) {
      for (const failure of ['refusal', 'transport', 'redirect']) {
        calls.length = 0;
        respond = async (url) => {
          if (url.pathname.endsWith('libraryDiary') !== (failed === 'diary')) return success(url);
          if (failure === 'transport') throw new TypeError('connection lost');
          return failure === 'redirect'
            ? new Response(null, { status: 302, headers: { location: 'https://other.test/private' } })
            : Response.json({ code: 'forbidden' }, { status: 403 });
        };
        const bad = { kind: failure === 'refusal' ? 'denied' : 'unavailable' };
        expect(await readPrivateDiary({ data: address })).toMatchObject({
          kind: 'ready',
          diary: failed === 'diary' ? bad : { kind: 'ready', page },
          ...('year' in address
            ? { reportedYear: failed === 'summary' ? bad : { kind: 'ready', value: yearSummary } }
            : { summary: failed === 'summary' ? bad : { kind: 'ready', value: summary } }),
        });
        expect(calls).toHaveLength(2);
        expect(calls.every(({ init }) => init.redirect === 'manual')).toBe(true);
      }
    }
});

test('abort rejects late success and normalized errors while replacement and command receipts stay independent', async () => {
  for (const [address, abortResponse] of [
    [{}, 'late-success'],
    [{ year: 2020 }, 'late-success'],
    [{}, 'error'],
    [{ year: 2020 }, 'error'],
  ] as const) {
    const lifetime = new AbortController();
    request = new Request('https://site.test/library/history', { signal: lifetime.signal });
    const abandonedSignal = request.signal;
    const entered = deferred();
    const release = deferred();
    calls.length = 0;
    respond = async (url, init) => {
      if (calls.length === 2) entered.resolve();
      if (init.signal === abandonedSignal) {
        await release.promise;
        if (abortResponse === 'error') abandonedSignal.throwIfAborted();
      }
      return success(url);
    };
    const abandoned = readPrivateDiary({ data: address });
    const rejected = expect(abandoned).rejects.toThrow('visit left');
    await entered.promise;
    lifetime.abort(new Error('visit left'));
    request = new Request('https://site.test/library/history');
    const replacement = { year: 2020, month: 4, cursor: 'replacement+/=' };
    expect(await readPrivateDiary({ data: replacement })).toMatchObject({
      kind: 'ready',
      address: replacement,
      diary: { kind: 'ready', page },
      reportedYear: { kind: 'ready', value: yearSummary },
    });
    expect(calls.slice(2).every(({ init }) => init.signal === request.signal && !init.signal.aborted)).toBe(true);
    expect(calls.slice(0, 2).every(({ init }) => init.signal === abandonedSignal && init.signal.aborted)).toBe(true);
    release.resolve();
    await rejected;
    expect(calls).toHaveLength(4);
  }
  const lifetime = new AbortController();
  request = new Request('https://site.test/library/history', { signal: lifetime.signal });
  const entered = deferred();
  const release = deferred();
  calls.length = 0;
  prepare = async () => {
    entered.resolve();
    await release.promise;
  };
  const preparing = readPrivateDiary({ data: {} });
  const rejected = expect(preparing).rejects.toThrow('visit left');
  await entered.promise;
  lifetime.abort(new Error('visit left'));
  release.resolve();
  await rejected;
  await expect(readPrivateDiary({ data: {} })).rejects.toThrow('visit left');
  await expect(
    Promise.all([
      readDiaryPage(client, 'Bearer current', undefined, {}, request.signal),
      readConsumptionSummary(client, 'Bearer current', request.signal),
      readReportedYearSummary(client, 'Bearer current', 2020, request.signal),
    ]),
  ).rejects.toThrow('visit left');
  expect(calls).toHaveLength(0);
  respond = async () => Response.json({ cancelled: true });
  const command = { viewer: 'owner', csrfToken: 'csrf', continuation: page.continuation };
  expect(await cancelPrivateDiary({ data: { ...command, viewer: 'other' } })).toBe('retired');
  expect(calls).toHaveLength(0);
  expect(await cancelPrivateDiary({ data: command })).toBe('cancelled');
  expect(calls).toHaveLength(1);
  expect(calls[0]!.init.method).toBe('POST');
  expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ continuation: page.continuation });
  expect(calls[0]!.init.signal?.aborted).not.toBe(true);
});
