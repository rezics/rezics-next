import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import * as start from '../.storybook/react-start';
import type { ReporterHistoryRead } from '../src/moderation/reporter-history/journey';
import type { ReporterHistoryQuery } from '../src/moderation/reporter-history/model';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);

test('served operands, exact own status and recovery form one fresh private route journey', async () => {
  const window = new Window({ url: 'https://site.test/moderation/reports' });
  window.scrollTo = () => undefined;
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    scrollTo: window.scrollTo,
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createMemoryHistory, createRootRouteWithContext, createRouter, Outlet, RouterProvider } =
    await import('@tanstack/react-router');
  const { getLocale, setLocale, deLocalizeUrl } = await import('../src/paraglide/runtime.js');
  const { browserObservation } = await import('../src/session/observation');
  const { viewerExposureQuery } = await import('../src/kernel/viewer-exposure');
  const { privateReaderFingerprint } = await import('../src/moderation/private-reader-origin');
  const historyServer = await import('../src/moderation/reporter-history/server');
  const statusServer = await import('../src/moderation/reporter-status-read');
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const reportId = '11111111-1111-8111-8111-123411111111';
  const otherId = '33333333-3333-8333-8333-345633333333';
  const targetId = '22222222-2222-7222-8222-234522222222';
  const origin = {
    subject: '44444444-4444-8444-8444-345644444444',
    csrfFingerprint: await privateReaderFingerprint('credential'),
  };
  cache.setQueryData(['session'], { state: 'signed-in', subject: origin.subject, csrfToken: 'credential' });
  const browser = browserObservation(cache);
  const stopBrowser = browser.subscribeCache(() => {});
  const admission = browser.getSnapshot();
  if (admission.state !== 'signed-in') throw new Error('Expected prepared reporter');
  cache.setQueryData(viewerExposureQuery(admission.observation).queryKey, { subject: origin.subject, admitted: [] });
  const reads: ReporterHistoryQuery[] = [];
  const cursor = 'opaque/+%2F ?frontier=two';
  let failNext = true;
  let mode: 'ready' | 'preparing' | 'expired' = 'ready';
  let resolveLate: (() => void) | undefined;
  let gate: Promise<void> | undefined;
  const read = async ({ data: query }: { data: ReporterHistoryQuery }): Promise<ReporterHistoryRead> => {
    reads.push({ ...query });
    const capturedMode = mode;
    if (gate) await gate;
    if (query.cursor === cursor && failNext) {
      failNext = false;
      return { readerOrigin: origin, result: { state: 'unavailable' } };
    }
    if (capturedMode === 'expired') return { readerOrigin: origin, result: { state: 'expired' } };
    const id = query.cursor ? otherId : reportId;
    return {
      readerOrigin: origin,
      result: {
        state: 'loaded',
        nativeSourceFingerprint: 'native-session',
        page: {
          state: capturedMode,
          selectedReportId: capturedMode === 'ready' && query.reportId === id ? id : null,
          retry: { cursor: query.cursor ?? null },
          nextCursor: capturedMode === 'preparing' || query.cursor ? null : cursor,
          viewer: { kind: 'reporter' },
          entries:
            capturedMode === 'preparing'
              ? []
              : [
                  {
                    id,
                    target: { kind: 'realm', id: targetId },
                    revisionId: null,
                    reason: 'spam',
                    evidence: 'Own evidence',
                    createdAt: '2026-11-01T10:00:00.000Z',
                    outcome: null,
                    resolvedAt: null,
                    targetSummary: { state: 'unavailable' },
                    viewer: { ownsReport: true },
                    actions: {
                      open: { method: 'GET', href: `/v1/reports/${id}` },
                      follow: { method: 'GET', href: `/v1/reports/${id}` },
                      target: null,
                    },
                  },
                ],
        },
      },
    };
  };
  const statuses: string[] = [];
  mock.module('../src/moderation/reporter-history/server', () => ({ ...historyServer, readReporterHistory: read }));
  mock.module('../src/moderation/reporter-status-read', () => ({
    ...statusServer,
    readReporterStatus: async ({ data }: { data: { id: string; generation: string } }) => {
      statuses.push(data.id);
      return {
        ...data,
        readerOrigin: origin,
        viewer: origin,
        result: {
          state: 'loaded',
          report: {
            id: data.id,
            target: { kind: 'realm', id: targetId },
            revisionId: null,
            reporterId: origin.subject,
            reason: 'spam',
            evidence: 'Exact own Realm evidence',
            createdAt: '2026-11-01T10:00:00.000Z',
            outcome: 'dismissed',
            resolvedAt: '2026-11-02T10:00:00.000Z',
            targetAvailability: 'unavailable',
          },
        },
      };
    },
  }));
  const { Route } = await import('../src/routes/moderation/reports.index');
  const { Route: StatusRoute } = await import('../src/routes/moderation/reports.$id');
  const parent = createRootRouteWithContext<{ queryClient: typeof cache }>()({ component: Outlet });
  // Mount the actual route options, loader preparation, consumed search and components.
  Route.update({ path: '/moderation/reports', getParentRoute: () => parent, head: () => ({}) } as never);
  StatusRoute.update({ path: '/moderation/reports/$id', getParentRoute: () => parent, head: () => ({}) } as never);
  const history = createMemoryHistory({ initialEntries: ['/moderation/reports'] });
  const router = createRouter({
    routeTree: parent.addChildren([Route, StatusRoute]),
    context: { queryClient: cache },
    history,
    defaultPendingMs: 0,
    defaultPendingMinMs: 0,
  });
  const host = window.document.createElement('main');
  const elsewhere = window.document.createElement('button');
  elsewhere.textContent = 'Elsewhere';
  window.document.body.append(elsewhere, host);
  const root = createRoot(host);
  const previousLocale = getLocale();
  setLocale('en', { reload: false });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text))!;
  const click = async (text: string) =>
    act(async () => {
      const source = button(text);
      source.focus();
      source.click();
      await tick();
    });
  const follow = async (link: HTMLAnchorElement) => {
    const url = deLocalizeUrl(new URL(link.href));
    await act(async () => {
      await router.navigate({ href: url.pathname + url.search });
    });
  };
  try {
    await act(async () => {
      await router.load();
      root.render(
        <QueryClientProvider client={cache}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      );
    });
    expect(reads).toEqual([{}]);
    await click('Load more');
    expect(router.state.location.search).toEqual({ cursor });
    expect(host.textContent).toContain('next page could not be loaded');
    expect(window.document.activeElement).toBe(host.querySelector('h1'));
    const failedAddress = history.location.href;
    await click('Try again');
    expect(history.location.href).toBe(failedAddress);
    expect(reads.slice(1, 3)).toEqual([{ cursor }, { cursor }]);
    await click('Select report');
    expect(router.state.location.search).toEqual({ cursor, reportId: otherId });
    expect(window.document.activeElement).toBe(host.querySelector('[aria-pressed="true"]'));
    const selectedAddress = history.location.href;
    await follow(host.querySelector<HTMLAnchorElement>('a[href*="historyReportId"]')!);
    expect(statuses).toEqual([otherId]);
    expect(host.textContent).toContain('Exact own Realm evidence');
    expect(host.textContent).toContain('Dismissed');
    expect(host.textContent).toContain('Realm');
    const back = host.querySelector<HTMLAnchorElement>('a')!;
    expect(new URL(back.href).searchParams.get('cursor')).toBe(cursor);
    await follow(back);
    expect(history.location.href).toBe(selectedAddress);
    expect(reads.at(-1)).toEqual({ cursor, reportId: otherId });
    expect(window.document.activeElement).toBe(host.querySelector('[aria-pressed="true"]'));
    const beforeBack = statuses.length;
    await act(async () => {
      history.back();
      await tick();
    });
    expect(statuses.length).toBeGreaterThan(beforeBack);
    await act(async () => {
      history.forward();
      await tick();
    });
    expect(history.location.href).toBe(selectedAddress);
    const beforeReload = reads.length;
    await act(async () => {
      await router.invalidate({ sync: true });
    });
    expect(reads).toHaveLength(beforeReload + 1);
    expect(reads.at(-1)).toEqual({ cursor, reportId: otherId });

    await act(async () => {
      await router.navigate({
        href: `/moderation/reports/${otherId}?historyReportId=${reportId}&historyCursor=bad&returnTo=https%3A%2F%2Fevil.test`,
      });
    });
    const safeReturn = new URL(host.querySelector<HTMLAnchorElement>('a')!.href);
    expect(safeReturn.pathname).toBe('/en/moderation/reports');
    expect(safeReturn.search).toBe('');
    await act(async () => {
      await router.navigate({ href: selectedAddress });
    });
    mode = 'preparing';
    await click('Refresh');
    expect(host.textContent).toContain('report history is being prepared');
    expect(host.textContent).not.toContain('You have not submitted any reports');
    expect(router.state.location.search).toEqual({ cursor, reportId: otherId });
    mode = 'expired';
    await click('Refresh');
    expect(host.textContent).toContain('Start over');
    mode = 'ready';
    await click('Start over');
    expect(router.state.location.search).toEqual({});
    expect(reads.at(-1)).toEqual({});

    // Retire focus and private publication while the replacement loader is in flight.
    gate = new Promise<void>((resolve) => {
      resolveLate = resolve;
    });
    await click('Load more');
    await act(async () => {
      elsewhere.focus();
      cache
        .getQueryCache()
        .find({ queryKey: ['session'] })!
        .invalidate();
    });
    await act(async () => {
      resolveLate!();
      await tick();
    });
    expect(window.document.activeElement).toBe(elsewhere);
    expect(host.textContent).not.toContain('Own evidence');
    expect(host.querySelector('a[href*="historyReportId"]')).toBeNull();
  } finally {
    resolveLate?.();
    await act(async () => root.unmount());
    stopBrowser();
    cache.clear();
    setLocale(previousLocale, { reload: false });
    mock.module('../src/moderation/reporter-history/server', () => historyServer);
    mock.module('../src/moderation/reporter-status-read', () => statusServer);
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    window.close();
  }
});
