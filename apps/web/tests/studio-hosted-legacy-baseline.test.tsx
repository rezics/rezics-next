import { afterAll, expect, mock, test } from 'bun:test';
import { act } from 'react';
import { createKernelClient } from '@rezics/client';
import * as v from 'valibot';
import type { StudioResult } from '../src/studio/contract';
import type { HostedOwnedBook } from '../src/studio/hosted-contract';
import type { HistoricalReaderObservation, HistoricalReaderSource } from '../src/threads/historical-reader-provenance';
import { HostedLegacyBaselineVisit, type BaselineTransport } from '../src/studio/hosted-legacy-baseline';
import {
  baselineBody,
  baselineNextBody,
  baselineProgress,
  baselineRequest,
  type BaselineProgress,
  type BaselineRequest,
} from '../src/studio/hosted-legacy-baseline-contract';
import { createBaselineAdvance } from '../src/studio/hosted-legacy-baseline-native';
import { baselineCopy } from '../src/studio/hosted-legacy-baseline-copy';
import { installPostReadingDom } from './post-reading-dom';

const dom = installPostReadingDom();
const { createRoot } = await import('react-dom/client');
const { getByRole, queryByRole } = await import('@testing-library/dom');
const { HostedLegacyBaselineView } = await import('../src/studio/hosted-legacy-baseline-view');
afterAll(() => dom.restore());
const id = (n: number) => `00000000-0000-8000-8000-${String(n).padStart(12, '0')}`;
const ok = <T,>(value: T): StudioResult<T> => ({ ok: true, value });
const fail = (kind: 'uncertain' | 'stale' | 'unavailable'): StudioResult<never> => ({
  ok: false,
  error: { kind, message: kind },
});
const version = { expectedRevisionId: id(4), expectedPublicationId: id(5) };
const cursor: NonNullable<BaselineProgress['receivingCursor']> = {
  phase: 'nodes',
  occurrenceAfterOrdinal: '9007199254740991',
  nodeAfterKind: 'siblings',
  nodeAfterId: id(80),
  rootNullDone: true,
  rootAfterParentId: id(81),
};
const progress = (nextStep: BaselineProgress['nextStep'] = 'build'): BaselineProgress => ({
  catalogueId: id(1),
  sourcePublicationId: id(5),
  expectedPlacementCount: 4200,
  nextStep,
  buildFrontier: { afterOrdinal: 19 },
  sealFromFrontier: { afterOrdinal: 17 },
  receivingCursor: cursor,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  let observation: HistoricalReaderObservation = {
    sourceId: 'baseline-session',
    generation: 1,
    dataUpdateCount: 1,
    dataUpdatedAt: 1,
    state: 'signed-in',
    subject: id(10),
    credentialMode: 'session',
    healthy: true,
    csrfReady: true,
  };
  const listeners = new Set<() => void>();
  const source: HistoricalReaderSource = {
    id: 'baseline-session',
    read: () => observation,
    revision: () => observation.generation,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const owner: HostedOwnedBook = {
    viewer: { accountId: id(10), authnEpoch: 2 },
    scope: { kind: 'all-homes', route: 0, crossHome: 'complete' },
    item: {
      catalogueId: id(1),
      threadId: id(2),
      postRevisionId: id(3),
      headRevisionId: id(4),
      publicationId: id(5),
      title: 'A public Book',
      postVisibility: 'published',
      createdAt: '2026-11-13T09:00:00Z',
    },
  };
  const native = {
    advance: mock(
      async (_request: BaselineRequest, _signal: AbortSignal, _csrf: string): Promise<StudioResult<BaselineProgress>> =>
        ok(progress()),
    ),
    readOwn: mock(async (): Promise<StudioResult<HostedOwnedBook>> => ok(owner)),
  } satisfies BaselineTransport;
  const options = { owner, source, csrfToken: 'original-csrf', locale: 'en' as const, native };
  const visit = new HostedLegacyBaselineVisit(options);
  return {
    visit,
    owner,
    native,
    options,
    listeners,
    replace(change: Partial<HistoricalReaderObservation>) {
      observation = { ...observation, ...change };
      for (const listener of [...listeners]) listener();
    },
  };
}

test('native next-step mapping preserves each opaque frontier and never derives done from source size', () => {
  expect(baselineNextBody(version, null)).toEqual({ ...version, step: 'startBuild' });
  for (const step of ['build', 'seal', 'receive', 'apply', 'complete', 'done'] as const) {
    const receipt = progress(step);
    const body = baselineNextBody({ ...version, catalogueId: id(1) } as typeof version, receipt);
    if (step === 'done') {
      expect(body).toBeNull();
      continue;
    }
    expect(body?.step).toBe(step);
    expect(body).toMatchObject(version);
    expect(v.is(baselineBody, body)).toBe(true);
    if (step === 'build' && body?.step === 'build') expect(body.frontier).toBe(receipt.buildFrontier);
    if ((step === 'seal' || step === 'receive') && body && 'frontier' in body)
      expect(body.frontier).toBe(receipt.sealFromFrontier);
    if (body?.step === 'apply') expect(body.cursor).toBe(receipt.receivingCursor);
    if (body?.step === 'complete')
      expect(Object.keys(body).sort()).toEqual(['expectedPublicationId', 'expectedRevisionId', 'step']);
  }
  expect(baselineNextBody(version, { ...progress(), expectedPlacementCount: 0 })?.step).toBe('build');
  expect(v.is(baselineBody, { ...version, expectedPublicationId: null, step: 'startBuild' })).toBe(false);
  expect(v.is(baselineProgress, { ...progress('seal'), sealFromFrontier: null })).toBe(false);
});

test('one Continue sends one POST, keeps the original version and gives each acknowledged step a new key', async () => {
  const f = fixture();
  expect(f.native.advance).not.toHaveBeenCalled();
  f.visit.confirmReview();
  expect(f.native.advance).not.toHaveBeenCalled();
  const keys = new Set<string>();
  for (const nextStep of ['build', 'build', 'seal', 'receive', 'apply', 'complete', 'done'] as const) {
    f.native.advance.mockImplementation(async () => ok(progress(nextStep)));
    const before = f.native.advance.mock.calls.length;
    await f.visit.continue();
    expect(f.native.advance).toHaveBeenCalledTimes(before + 1);
    const request = f.native.advance.mock.calls.at(-1)![0];
    expect(request.body).toMatchObject(version);
    expect(v.is(baselineRequest, request)).toBe(true);
    expect(keys.has(request.idempotencyKey)).toBe(false);
    keys.add(request.idempotencyKey);
  }
  expect(f.visit.snapshot()).toMatchObject({ phase: 'done', progress: { nextStep: 'done' } });
  await f.visit.continue();
  expect(f.native.advance).toHaveBeenCalledTimes(7);
  expect(f.native.readOwn).not.toHaveBeenCalled();
  f.visit.dispose();
});

test('unknown replay retains the exact body, key and CSRF through later owner observations and read failures', async () => {
  const f = fixture();
  f.visit.confirmReview();
  await f.visit.continue();
  f.native.advance.mockImplementation(async () => fail('uncertain'));
  await f.visit.continue();
  const unknown = f.visit.snapshot();
  expect(unknown).toMatchObject({ phase: 'unknown', progress: progress() });
  f.native.readOwn.mockImplementation(async () =>
    ok({ ...f.owner, item: { ...f.owner.item, publicationId: id(99), headRevisionId: id(98) } }),
  );
  await f.visit.refreshReview();
  f.native.readOwn.mockImplementation(async () => fail('unavailable'));
  await f.visit.refreshReview();
  expect(f.visit.snapshot()).toMatchObject({
    phase: 'unknown',
    readFailed: true,
    progress: progress(),
    original: version,
  });
  f.native.advance.mockImplementation(async () => ok(progress('seal')));
  await f.visit.continue();
  const [first, , firstCsrf] = f.native.advance.mock.calls[1]!;
  const [retry, , retryCsrf] = f.native.advance.mock.calls[2]!;
  expect(retry).toBe(first);
  expect(retry.body).toEqual({ ...version, step: 'build', frontier: progress().buildFrontier });
  expect(firstCsrf).toBe('original-csrf');
  expect(retryCsrf).toBe(firstCsrf);
  f.visit.dispose();
});

test('412 retains the original review, requires a fresh owner read and explicit confirmation, then starts a new intent', async () => {
  const f = fixture();
  f.visit.confirmReview();
  f.native.advance.mockImplementation(async () => fail('stale'));
  await f.visit.continue();
  const first = f.native.advance.mock.calls[0]![0];
  f.visit.confirmReview();
  await f.visit.continue();
  expect(f.native.advance).toHaveBeenCalledTimes(1);
  expect(f.visit.snapshot()).toMatchObject({ phase: 'stale', original: version });
  const updated = { ...f.owner, item: { ...f.owner.item, headRevisionId: id(7), publicationId: id(8) } };
  f.native.readOwn.mockImplementation(async () => ok(updated));
  await f.visit.refreshReview();
  expect(f.visit.snapshot()).toMatchObject({ phase: 'review', original: version, candidate: updated });
  await f.visit.continue();
  expect(f.native.advance).toHaveBeenCalledTimes(1);
  f.visit.confirmReview();
  f.native.advance.mockImplementation(async () => ok({ ...progress(), sourcePublicationId: id(8) }));
  await f.visit.continue();
  const second = f.native.advance.mock.calls[1]![0];
  expect(second.body).toEqual({ expectedRevisionId: id(7), expectedPublicationId: id(8), step: 'startBuild' });
  expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
  f.visit.dispose();
});

test('HTTP boundaries reject malformed progress and keep a single no-store generated request', async () => {
  const calls: Request[] = [];
  let wire: unknown = progress('receive');
  let status = 200;
  const client = createKernelClient('http://kernel.invalid', {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Request(input, init));
      return Response.json(wire, { status });
    }) as typeof fetch,
  });
  const advance = createBaselineAdvance(client);
  const request: BaselineRequest = {
    catalogueId: id(1),
    expectedViewer: { accountId: id(10), authnEpoch: 2 },
    idempotencyKey: id(60),
    body: { ...version, step: 'seal', frontier: { afterOrdinal: 17 } },
  };
  expect(await advance(request, new AbortController().signal, 'csrf')).toEqual(ok(wire));
  expect(calls).toHaveLength(1);
  expect(new URL(calls[0]!.url).pathname).toBe(`/v1/hostedCatalogues/${id(1)}:advanceLegacyPublicBaseline`);
  expect(calls[0]!.cache).toBe('no-store');
  expect(calls[0]!.method).toBe('POST');
  expect(JSON.parse(calls[0]!.headers.get('idempotency-key')!)).toBe(request.idempotencyKey);
  expect(await calls[0]!.json()).toEqual(request.body);
  for (wire of [
    { ...progress(), catalogueId: id(98) },
    { ...progress(), sourcePublicationId: id(98) },
    { ...progress('apply'), receivingCursor: null },
    { ...progress(), unexpected: true },
  ]) {
    expect(await advance(request, new AbortController().signal, 'csrf')).toMatchObject({
      error: { kind: 'uncertain' },
    });
  }
  status = 412;
  expect(await advance(request, new AbortController().signal, 'csrf')).toMatchObject({ error: { kind: 'stale' } });
});

test('departure and session ABA abort and retire private state, subscriptions and late callbacks permanently', async () => {
  for (const change of [
    { generation: 2 },
    { sourceId: 'replacement' },
    { subject: id(98) },
    { healthy: false },
    { csrfReady: false },
  ]) {
    const f = fixture();
    const pending = deferred<StudioResult<BaselineProgress>>();
    f.native.advance.mockImplementation(() => pending.promise);
    f.visit.confirmReview();
    const task = f.visit.continue();
    const signal = f.native.advance.mock.calls[0]![1];
    f.replace(change);
    f.replace({ generation: 1, sourceId: 'baseline-session', subject: id(10), healthy: true, csrfReady: true });
    pending.resolve(ok(progress('done')));
    await task;
    expect(signal.aborted).toBe(true);
    expect(f.visit.snapshot()).toEqual({ kind: 'ended' });
    expect(f.listeners.size).toBe(0);
    await f.visit.continue();
    expect(f.native.advance).toHaveBeenCalledTimes(1);
  }
  const f = fixture();
  const pending = deferred<StudioResult<HostedOwnedBook>>();
  f.native.readOwn.mockImplementation(() => pending.promise);
  const task = f.visit.refreshReview();
  f.visit.dispose();
  pending.resolve(ok(f.owner));
  await task;
  expect(f.visit.snapshot()).toEqual({ kind: 'ended' });
});

test('mounted recovery and done states disclose private progress, provide keyboard focus and only the existing point visit', async () => {
  const f = fixture();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<HostedLegacyBaselineView visit={f.visit} locale="en" />));
  await act(async () => getByRole(container, 'button', { name: baselineCopy.en.confirm }).click());
  f.native.advance.mockImplementation(async () => fail('uncertain'));
  await act(async () => getByRole(container, 'button', { name: baselineCopy.en.continue }).click());
  expect(getByRole(container, 'button', { name: baselineCopy.en.retry })).toBeTruthy();
  expect(document.activeElement?.tagName).toBe('H2');
  f.native.advance.mockImplementation(async () => ok(progress('done')));
  await act(async () => getByRole(container, 'button', { name: baselineCopy.en.retry }).click());
  expect(container.textContent).toContain('Preparation has not published anything');
  expect(queryByRole(container, 'progressbar')).toBeNull();
  expect(queryByRole(container, 'button', { name: baselineCopy.en.continue })).toBeNull();
  expect(getByRole(container, 'link', { name: baselineCopy.en.point }).getAttribute('href')).toContain(
    `/studio?catalogueId=${id(1)}&points=1`,
  );
  expect(container.querySelector('a[href*="/books/"]')).toBeNull();
  await act(async () => f.visit.dispose());
  expect(container.textContent).not.toContain(id(5));
  await act(async () => root.unmount());
  container.remove();
});

test('the mounted entry retires in-flight work on locale, catalogue, account, source and CSRF replacement', async () => {
  const f = fixture();
  mock.module('../src/studio/hosted-legacy-baseline-actions', () => ({ hostedBaselineTransport: f.native }));
  const { HostedLegacyBaselineEntry } = await import('../src/studio/hosted-legacy-baseline-entry');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const initial = {
    owner: f.owner,
    source: f.options.source,
    accountId: id(10),
    csrfToken: 'first-csrf',
    locale: 'en' as const,
  };
  const replacements = [
    { ...initial, locale: 'de' as const },
    { ...initial, owner: { ...f.owner, item: { ...f.owner.item, catalogueId: id(90) } } },
    { ...initial, accountId: id(91) },
    { ...initial, source: { ...f.options.source } },
    { ...initial, csrfToken: 'replacement-csrf' },
  ];
  for (const replacement of replacements) {
    await act(async () => root.render(<HostedLegacyBaselineEntry {...initial} />));
    await act(async () => getByRole(container, 'button', { name: baselineCopy.en.confirm }).click());
    const pending = deferred<StudioResult<BaselineProgress>>();
    f.native.advance.mockImplementation(() => pending.promise);
    await act(async () => getByRole(container, 'button', { name: baselineCopy.en.continue }).click());
    const signal = f.native.advance.mock.calls.at(-1)![1];
    await act(async () => root.render(<HostedLegacyBaselineEntry {...replacement} />));
    expect(signal.aborted).toBe(true);
    await act(async () => {
      pending.resolve(ok(progress('done')));
    });
    expect(container.textContent).not.toContain(baselineCopy.en.done);
    await act(async () => root.render(null));
  }
  await act(async () => root.unmount());
  container.remove();
  f.visit.dispose();
  mock.restore();
});
