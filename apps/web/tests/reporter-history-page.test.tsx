import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as start from '../.storybook/react-start';
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
const { operationGroups } = await import('../src/kernel/exposure');
import { reporterHistoryReturnHref, reporterHistoryStatusHref } from '../src/moderation/reporter-history/navigation';
import { prepareReporterHistoryVisit, type ReporterHistoryReader } from '../src/moderation/reporter-history/journey';
import type {
  ReporterHistoryEntry,
  ReporterHistoryPage as HistoryPage,
  ReporterHistoryQuery,
} from '../src/moderation/reporter-history/model';
import { privateReaderFingerprint } from '../src/moderation/private-reader-origin';
const { ReporterStatusPage } = await import('../src/moderation/reporter-status-view');
const { libraryNavigation } = await import('../src/library/navigation');
import { m } from '../src/paraglide/messages.js';
import { getLocale, localizeHref, locales, setLocale } from '../src/paraglide/runtime.js';

const reportId = '11111111-1111-8111-8111-123411111111';
const secondReportId = '33333333-3333-8333-8333-345633333333';
const targetId = '22222222-2222-7222-8222-234522222222';

function entry(id: string, title: string): ReporterHistoryEntry {
  return {
    id,
    target: { kind: 'thread', id: targetId },
    revisionId: null,
    reason: 'spam',
    evidence: 'Private submission evidence',
    createdAt: '2026-10-27T08:00:00.000Z',
    outcome: null,
    resolvedAt: null,
    targetSummary: { state: 'available', label: title, href: `/v1/threads/${targetId}` },
    viewer: { ownsReport: true },
    actions: {
      open: { method: 'GET', href: `/v1/reports/${id}` },
      follow: { method: 'GET', href: `/v1/reports/${id}` },
      target: { method: 'GET', href: `/v1/threads/${targetId}` },
    },
  };
}

function page(
  entries: readonly ReporterHistoryEntry[],
  cursor: string | undefined,
  selectedReportId: string | null = null,
  nextCursor: string | null = null,
): HistoryPage {
  return {
    state: 'ready',
    entries,
    selectedReportId,
    nextCursor,
    retry: { cursor: cursor ?? null },
    viewer: { kind: 'reporter' },
  };
}

test('My reports is a signed-in Library destination without a private operation gate and provides a fixed local return', () => {
  const destinations = libraryNavigation.filter((item) => item.id === 'library.own-reports');
  expect(destinations).toHaveLength(1);
  expect(destinations[0]).toMatchObject({
    href: '/moderation/reports',
    group: 'personal',
    signedIn: true,
  });
  expect(destinations[0]).not.toHaveProperty('operation');
  expect(Object.hasOwn(operationGroups, 'report.own_history')).toBe(false);
  const label = destinations[0]!.label;
  if (typeof label !== 'function') throw new Error('My reports must use a localized label');
  for (const locale of locales) expect(label({ locale, pathname: '/moderation/reports' })).toBeTruthy();

  const cursor = 'opaque/+%2F cursor';
  const back = reporterHistoryReturnHref(
    { historyCursor: cursor, historyReportId: reportId, returnTo: 'https://untrusted.example/path' },
    reportId,
  );
  const destination = new URL(back!, 'https://site.test');
  expect(destination.origin).toBe('https://site.test');
  expect(destination.pathname).toBe('/moderation/reports');
  expect(destination.searchParams.get('cursor')).toBe(cursor);
  expect(destination.searchParams.get('reportId')).toBe(reportId);
  expect(reporterHistoryReturnHref({ historyReportId: secondReportId }, reportId)).toBeNull();
  expect(
    new URL(reporterHistoryStatusHref(reportId, cursor), 'https://site.test').searchParams.get('historyCursor'),
  ).toBe(cursor);
});

test('mounted history replaces one page, retries the exact cursor, opens selected status and retires on exposure replacement', async () => {
  const { dirname } = await import('node:path');
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/moderation/reports?cursor=start%2Ffrontier' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  const { ReporterHistoryCurrent, ReporterHistoryPage } = await import('../src/moderation/reporter-history/view');
  const { sessionQuery } = await import('../src/session/query');
  const { viewerExposureLifetime, viewerExposureQuery } = await import('../src/kernel/viewer-exposure');
  const previousLocale = getLocale();
  setLocale('en', { reload: false });
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  cache.setQueryData(sessionQuery.queryKey, {
    state: 'signed-in',
    subject: 'reporter-account',
    csrfToken: 'credential',
  });
  const exposureOwner = viewerExposureLifetime(cache);
  const releaseExposure = exposureOwner.subscribe(() => {});
  const admission = exposureOwner.getSnapshot();
  if (admission.state !== 'signed-in') throw new Error('The mounted test needs its prepared browser account');
  cache.setQueryData(viewerExposureQuery(admission.observation).queryKey, {
    subject: 'reporter-account',
    admitted: [],
  });
  const origin = {
    subject: 'reporter-account',
    csrfFingerprint: await privateReaderFingerprint('credential'),
  };
  const first = entry(reportId, 'First private report');
  const second = entry(secondReportId, 'Selected private report');
  const initial = await prepareReporterHistoryVisit(cache, { cursor: 'start/frontier' }, 'en', async (query) => ({
    readerOrigin: origin,
    result: {
      state: 'loaded',
      nativeSourceFingerprint: 'native-source',
      page: { ...page([first], query.cursor, null, 'next/frontier'), retry: { cursor: query.cursor ?? null } },
    },
  }));
  const reads: ReporterHistoryQuery[] = [];
  let continuationAttempts = 0;
  const read: ReporterHistoryReader = async (query) => {
    reads.push({ ...query });
    if (query.cursor === 'next/frontier' && query.reportId === undefined && continuationAttempts++ === 0)
      throw new Error('Retry the same cursor');
    const selected = query.reportId === secondReportId;
    return {
      readerOrigin: origin,
      result: {
        state: 'loaded',
        nativeSourceFingerprint: 'native-source',
        page: {
          ...page([second], query.cursor, selected ? secondReportId : null),
          retry: { cursor: query.cursor ?? null },
        },
      },
    };
  };
  const container = window.document.createElement('div');
  window.document.body.append(container);
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container);
  const draw = () =>
    createElement(QueryClientProvider, { client: cache }, createElement(ReporterHistoryCurrent, { initial, read }));

  try {
    await act(async () => {
      root.render(draw());
    });
    expect(container.textContent).toContain('First private report');

    const continueButton = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Load more'),
    );
    if (!continueButton) throw new Error('The first page should offer its sparse continuation');
    await act(async () => {
      continueButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('next page could not be loaded');

    const retryButton = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Try again'),
    );
    if (!retryButton) throw new Error('The failed continuation should expose retry');
    await act(async () => {
      retryButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(reads.slice(0, 2)).toEqual([{ cursor: 'next/frontier' }, { cursor: 'next/frontier' }]);
    expect(container.textContent).toContain('Selected private report');
    expect(container.textContent).not.toContain('First private report');

    const selectButton = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Select report'),
    );
    if (!selectButton) throw new Error('The continuation report should be selectable');
    await act(async () => {
      selectButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(reads[2]).toEqual({ cursor: 'next/frontier', reportId: secondReportId });
    const statusLink = container.querySelector<HTMLAnchorElement>('a[href*="historyReportId"]');
    if (!statusLink) throw new Error('Selecting a report should reopen its existing status journey');
    const statusUrl = new URL(statusLink.href);
    expect(statusUrl.pathname).toBe(`/en/moderation/reports/${secondReportId}`);
    expect(statusUrl.searchParams.get('historyCursor')).toBe('next/frontier');
    expect(statusUrl.searchParams.get('historyReportId')).toBe(secondReportId);

    await act(async () => {
      cache.setQueryData(viewerExposureQuery(admission.observation).queryKey, {
        subject: 'reporter-account',
        admitted: ['personal_library'],
      });
      await Promise.resolve();
    });
    expect(container.textContent).not.toContain('Selected private report');
    expect(container.textContent).not.toContain('spam');
  } finally {
    await act(async () => root.unmount());
    releaseExposure();
    cache.clear();
    setLocale(previousLocale, { reload: false });
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    window.close();
  }
});

test('localized page states distinguish preparation, completion, denial, continuation retry, selection and expiry', async () => {
  const { ReporterHistoryPage } = await import('../src/moderation/reporter-history/view');
  const currentLocale = getLocale();
  setLocale('en', { reload: false });
  const render = (result: Parameters<typeof ReporterHistoryPage>[0]['result'], query: ReporterHistoryQuery = {}) =>
    renderToStaticMarkup(createElement(ReporterHistoryPage, { result, query }));
  try {
    const preparing = render({
      state: 'loaded',
      nativeSourceFingerprint: 'source',
      page: { ...page([], undefined), state: 'preparing' },
    });
    expect(preparing).toContain('report history is being prepared');
    expect(preparing).not.toContain('You have not submitted any reports');
    expect(render({ state: 'loaded', nativeSourceFingerprint: 'source', page: page([], undefined) })).toContain(
      'You have not submitted any reports',
    );
    const sparse = render({
      state: 'loaded',
      nativeSourceFingerprint: 'source',
      page: page([], undefined, null, 'next'),
    });
    expect(sparse).toContain('continue to the next page');
    expect(sparse).not.toContain('You have not submitted any reports');
    expect(render({ state: 'denied' })).toContain('not available for this session');
    expect(render({ state: 'unavailable' }, { cursor: 'same-frontier' })).toContain('next page could not be loaded');
    expect(
      render({ state: 'loaded', nativeSourceFingerprint: 'source', page: page([], undefined) }, { reportId }),
    ).toContain('selected report is unavailable');
    expect(render({ state: 'expired' }, { cursor: 'expired-frontier', reportId })).toContain('Start over');

    const cursor = 'opaque/+%2F cursor';
    const back = reporterHistoryReturnHref({ historyCursor: cursor, historyReportId: reportId }, reportId)!;
    const status = renderToStaticMarkup(
      createElement(ReporterStatusPage, { state: 'closed', returnHref: localizeHref(back) }),
    );
    expect(status).toContain(m.reporter_history_return());

    for (const locale of locales) {
      setLocale(locale, { reload: false });
      const sparse = render({
        state: 'loaded',
        nativeSourceFingerprint: 'source',
        page: page([], undefined, null, 'next'),
      });
      expect(sparse).toContain('continue to the next page');
      expect(sparse).not.toContain('You have not submitted any reports');
      expect(render({ state: 'denied' })).toContain(m.reporter_history_denied());
    }
  } finally {
    setLocale(currentLocale, { reload: false });
  }
});
