import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFile } from 'node:fs/promises';
import { ReporterStatusPage, ReporterStatusView } from '../src/moderation/reporter-status-view';
import { reporterStatusResponse, type ReporterStatus } from '../src/moderation/reporter-status-model';
import * as start from '../.storybook/react-start';
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
const { isSignedInPath } = await import('../src/session/guard');
import { createKernelClient } from '@rezics/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { getLocale, setLocale } from '../src/paraglide/runtime.js';
import { setStoryRequestContext } from '../.storybook/react-start';

const submission: ReporterStatus = {
  id: '11111111-1111-8111-8111-123411111111',
  target: { kind: 'post', id: '22222222-2222-8222-8222-123422222222' },
  revisionId: '33333333-3333-8333-8333-123433333333',
  reason: 'spam',
  evidence: 'The original evidence I submitted.',
  reporterId: '44444444-4444-8444-8444-123444444444',
  createdAt: '2026-10-30T10:00:00.000Z',
  resolvedAt: null,
  outcome: null,
  targetAvailability: 'unavailable',
};

test('reporter presentation retains submission and reference after removal, with each native status and no target link', () => {
  for (const [outcome, label] of [
    [null, 'Pending review'],
    ['actioned', 'Actioned'],
    ['dismissed', 'Dismissed'],
  ] as const) {
    const report = { ...submission, outcome, resolvedAt: outcome ? '2026-10-31T10:00:00.000Z' : null };
    const html = renderToStaticMarkup(createElement(ReporterStatusView, { report }));
    for (const value of [
      label,
      submission.evidence!,
      submission.target.id,
      submission.revisionId!,
      'This content is unavailable.',
    ])
      expect(html).toContain(value);
    expect(html).toContain(`dateTime="${submission.createdAt}"`);
    expect(html).not.toContain('href=');
    expect(html).not.toContain('reporter-1');
  }
});

test('only the own-submission DTO is accepted and private additions cannot cross the web boundary', () => {
  expect(
    reporterStatusResponse({
      report: { ...submission, moderatorNotes: 'Private note', body: 'Hidden text', otherReports: ['other'] },
    }),
  ).toEqual(submission);
  const { targetAvailability: _availability, ...moderator } = submission;
  expect(() =>
    reporterStatusResponse({ report: { ...moderator, partition: 1, transactionId: 'transaction' } }),
  ).toThrow();
  expect(() => reporterStatusResponse({ report: { ...submission, reporterId: null } })).toThrow();
});

test('successful receipt is retained and the served status route uses the private owning reader', async () => {
  const [actions, route, reader] = await Promise.all([
    readFile(new URL('../src/report/content-actions.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/routes/moderation/reports.$id.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/moderation/reporter-status-read.ts', import.meta.url), 'utf8'),
  ]);
  expect(actions).toContain('setReportId(result.reportId)');
  expect(actions).toContain('/moderation/reports/${reportId}');
  expect(route).toMatch(/beforeLoad:\s*requireSignedIn/);
  expect(route).toContain('noindex, nofollow');
  expect(reader).toContain('private, no-store');
  expect(reader).toContain('result.status === 404');
  expect(isSignedInPath('/en/moderation/reports/report-1')).toBe(true);
});

test('the served receipt explains its actioned disposition and separates submitted evidence, timeline and copyable reference', () => {
  const report = reporterStatusResponse({
    report: {
      ...submission,
      outcome: 'actioned',
      resolvedAt: '2026-10-31T10:00:00.000Z',
      moderatorNotes: 'Private moderator discussion',
      otherReports: ['Another reporter’s evidence'],
      body: 'Currently withheld target body',
      appeal: { outcome: 'reversed' },
    },
  });
  const html = renderToStaticMarkup(createElement(ReporterStatusPage, { report }));
  for (const value of [
    'Your report',
    'Actioned',
    'a later appeal does not change it',
    'Submitted',
    'Reviewed',
    'Your submission',
    'Evidence you submitted',
    'The original evidence I submitted.',
    'This content is unavailable.',
    'Report reference',
    'Copy reference',
    'Back to inbox',
  ])
    expect(html).toContain(value);
  expect(html).toContain(`dateTime="${submission.createdAt}"`);
  expect(html).toContain('dateTime="2026-10-31T10:00:00.000Z"');
  expect(html).toContain('<details');
  expect(html).toContain(submission.id);
  expect(html).toContain(`post ${submission.target.id}`);
  expect(html).toContain(submission.revisionId!);
  expect(html.match(/href=/g)).toHaveLength(1);
  expect(html).toMatch(/href="(?:\/en)?\/inbox"/);
  for (const hidden of [
    'Private moderator discussion',
    'Another reporter’s evidence',
    'Currently withheld target body',
    'reversed',
    submission.reporterId,
  ])
    expect(html).not.toContain(hidden);
});

test('the served error state offers an explicit retry and inbox return without a fabricated report', () => {
  const html = renderToStaticMarkup(createElement(ReporterStatusPage, { onRetry: () => undefined }));
  expect(html).toContain('Your report');
  expect(html).toContain('role="alert"');
  expect(html).toContain('Your report could not be loaded. Try again.');
  expect(html).toContain('Try again');
  expect(html).toContain('Back to inbox');
  for (const value of [
    'Pending review',
    'Actioned',
    'Dismissed',
    'Report reference',
    submission.evidence ?? 'missing evidence',
  ])
    expect(html).not.toContain(value);
});

test('actual submitted report page resolves its owned source and renders exactly one accessible main in AppShell while unavailable and retry remain honest', async () => {
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const [{ loadReporterStatus }, { createStoryRecordedKernelFetch }, { AppShell }] = await Promise.all([
    import('../src/moderation/reporter-status-read'),
    import('../src/kernel/fake'),
    import('../src/shell/shell'),
  ]);
  const id = '01a17a3b-0884-721b-91ef-d7ffd7bb58f3';
  const path = `/en/moderation/reports/${id}?fixture=report-unavailable`;
  const runtime = globalThis as typeof globalThis & {
    __rezicsStoryContext?: { visitor: 'Signed In' | 'Signed Out'; url: string };
  };
  const previousContext = runtime.__rezicsStoryContext;
  setStoryRequestContext({ visitor: 'Signed In', url: path });
  const queryClient = new QueryClient();
  try {
    const calls: string[] = [];
    const recordedFetch = createStoryRecordedKernelFetch();
    const client = createKernelClient('http://kernel.local', {
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        calls.push(`${request.method} ${new URL(request.url).pathname}`);
        expect(request.headers.get('authorization')).toBe('Bearer reporter');
        return recordedFetch(request);
      }) as typeof fetch,
    });
    const report = await loadReporterStatus(client, id, 'Bearer reporter');
    expect(report).toEqual({
      id,
      target: { kind: 'post', id: '01a17a3b-0884-721b-91ef-d7ffd7bb58f2' },
      revisionId: '01a17a3b-0884-721b-91ef-d7ffd7bb58f6',
      reason: 'spam',
      evidence: 'Repeated advertising in this discussion.',
      reporterId: '01a17a3b-0884-721b-91ef-d7ffd7bb58f0',
      createdAt: '2026-10-27T08:00:00.000Z',
      outcome: 'dismissed',
      resolvedAt: '2026-10-28T08:00:00.000Z',
      targetAvailability: 'unavailable',
    });
    expect(calls).toEqual([`GET /v1/reports/${id}`]);
    if (!report) throw new Error('The submitted report fixture must resolve');

    let failed = false;
    const root = createRootRoute({
      component: () =>
        createElement(AppShell, {
          children: failed
            ? createElement(ReporterStatusPage, {
                onRetry: async () => {
                  throw new Error('Report status unavailable');
                },
              })
            : createElement(ReporterStatusPage, { report }),
        }),
    });
    const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [path] }) });
    await router.load();
    const render = () =>
      renderToStaticMarkup(
        createElement(QueryClientProvider, { client: queryClient }, createElement(RouterProvider, { router })),
      );
    const html = render();
    expect(html.match(/<main\b/g)).toHaveLength(1);
    expect(html).toMatch(/<main[^>]*id="main-content"/);
    expect(html).not.toMatch(/<main[^>]*(?:hidden|aria-hidden="true")/);
    expect(html).toContain('Repeated advertising in this discussion.');
    expect(html).toContain('Dismissed');
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain(report.reporterId);

    const unavailable = createKernelClient('http://kernel.local', {
      fetch: (async () => Response.json({ code: 'dependency_unavailable' }, { status: 503 })) as typeof fetch,
    });
    await expect(loadReporterStatus(unavailable, id, 'Bearer reporter')).rejects.toThrow('Report status unavailable');
    failed = true;
    const failure = render();
    expect(failure.match(/<main\b/g)).toHaveLength(1);
    expect(failure).toContain('role="alert"');
    expect(failure).toContain('Try again');
    expect(failure).not.toContain(report.evidence!);
    await expect(loadReporterStatus(unavailable, id, 'Bearer reporter')).rejects.toThrow('Report status unavailable');
    const missing = createKernelClient('http://kernel.local', {
      fetch: (async () => Response.json({ code: 'not_found' }, { status: 404 })) as typeof fetch,
    });
    expect(await loadReporterStatus(missing, id, 'Bearer reporter')).toBeNull();
  } finally {
    queryClient.clear();
    if (previousContext) runtime.__rezicsStoryContext = previousContext;
    else delete runtime.__rezicsStoryContext;
  }
});

test('the default private reporter-status journey refreshes outcomes, retries failures and retires private evidence and late reads on session replacement', async () => {
  const { dirname } = await import('node:path');
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/moderation/reports/01a17a3b-0884-721b-91ef-d7ffd7bb58f3' });
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
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { ReporterStatusCurrent } = await import('../src/moderation/reporter-status-view');
  const { prepareReporterStatusRead } = await import('../src/moderation/reporter-status-read-model');
  const { sessionQuery } = await import('../src/session/query');
  const { m } = await import('../src/paraglide/messages.js');
  const reader = await import('../src/moderation/reporter-status-read');
  const originalRead = reader.readReporterStatus;
  const requestRead = reader.loadReporterStatusRequest;
  const id = '01a17a3b-0884-721b-91ef-d7ffd7bb58f3';
  let report = { ...submission, id };
  const original = { state: 'signed-in' as const, subject: submission.reporterId, csrfToken: 'first-browser-session' };
  let browser = original;
  let status = 200;
  let closed = false;
  let release: (() => void) | undefined;
  let gate: Promise<void> | undefined;
  const calls: string[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      calls.push(`${request.method} ${new URL(request.url).pathname}`);
      expect(request.headers.get('authorization')).toBe(`Bearer ${browser.subject}`);
      const responseStatus = status;
      const responseReport = { ...report, reporterId: browser.subject };
      if (gate) await gate;
      return Response.json(
        responseStatus === 200
          ? { report: responseReport }
          : {
              code: closed
                ? 'platform_closed'
                : responseStatus === 404
                  ? 'not_found'
                  : responseStatus === 403
                    ? 'forbidden'
                    : 'dependency_unavailable',
              detail: 'Private infrastructure diagnostics',
            },
        { status: responseStatus, headers: { 'rezics-session-token': 'native-status-session' } },
      );
    }) as typeof fetch,
  });
  const sessionEnv = {
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://kernel.test',
    WEBSITE_SCOPES: 'openid',
    WEBSITE_CLIENT_ID: 'web',
    WEBSITE_CLIENT_KEY: '{}',
    SESSIONS: {
      idFromName: (name: string) => name,
      get: () => ({
        credential: async () => ({
          status: 'active',
          subject: browser.subject,
          accessToken: browser.subject,
          csrfToken: browser.csrfToken,
        }),
      }),
    },
  } as unknown as import('../src/session/client').SessionEnv;
  // Replace only the server-function transport; retain real preparation, generated GET and private projection.
  const transport = ({ data }: { data: { id: string; generation: string } }) =>
    requestRead(
      new Request(window.location.href, { headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` } }),
      sessionEnv,
      data,
      () => client,
    );
  mock.module('../src/moderation/reporter-status-read', () => ({ ...reader, readReporterStatus: transport }));
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // The site shell keeps the shared browser observation mounted across replacing route visits.
  const { browserObservation } = await import('../src/session/observation');
  const stopShell = browserObservation(cache).subscribeCache(() => {});
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const flush = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  const setSession = async (session: typeof original | { state: 'signed-out'; subject: null; csrfToken: null }) => {
    if (session.state === 'signed-in') browser = session;
    await act(async () => {
      cache.setQueryData(sessionQuery.queryKey, session);
    });
  };
  const load = () => prepareReporterStatusRead(cache, id, (data) => transport({ data }));
  const mount = async () => {
    const initial = await load();
    await act(async () =>
      root.render(
        createElement(
          QueryClientProvider,
          { client: cache },
          createElement(ReporterStatusCurrent, { key: initial.generation, initial }),
        ),
      ),
    );
  };
  const clickRead = async (label: string) => {
    const buttons = [...host.querySelectorAll('button')].filter((item) => item.textContent?.includes(label));
    expect(buttons).toHaveLength(1);
    const button = buttons[0];
    await act(async () => {
      button!.click();
      button!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  const retry = () => clickRead(m.sources_retry());
  const refresh = () => clickRead(m.reporter_status_refresh());
  const absent = () => {
    for (const bytes of [report.evidence!, report.revisionId!, report.target.id, 'Private infrastructure diagnostics'])
      expect(host.textContent).not.toContain(bytes);
    expect(host.querySelectorAll('a')).toHaveLength(1);
  };
  try {
    await setSession(original);
    await mount();
    expect(host.textContent).toContain(report.evidence!);
    expect(host.textContent).toContain(m.moderation_target_unavailable());
    for (const next of ['actioned', 'dismissed'] as const) {
      report = { ...report, outcome: null, resolvedAt: null };
      await mount();
      expect(host.textContent).toContain(m.reporter_status_pending());
      const before = calls.length;
      await flush();
      expect(calls).toHaveLength(before);
      report = { ...report, outcome: next, resolvedAt: '2026-10-31T10:00:00.000Z' };
      gate = new Promise((resolve) => {
        release = resolve;
      });
      await refresh();
      expect(calls).toHaveLength(before + 1);
      expect(host.textContent).toContain(m.reporter_status_read_loading());
      absent();
      release!();
      await flush();
      gate = undefined;
      expect(host.textContent).toContain(next === 'actioned' ? m.moderation_actioned() : m.moderation_dismissed());
      expect(host.textContent).toContain(report.evidence!);
    }
    // A real cache replacement for the same account retires the loaded report and pending clipboard settlement.
    let copied!: () => void;
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (value: string) => {
          expect(value).toBe(
            [
              `${m.reporter_status_report_id()}: ${report.id}`,
              `${m.reporter_status_target()}: ${report.target.kind} ${report.target.id}`,
              `${m.reporter_status_revision()}: ${report.revisionId}`,
            ].join('\n'),
          );
          return new Promise<void>((resolve) => {
            copied = resolve;
          });
        },
      },
    });
    const copy = [...host.querySelectorAll('button')].find((item) =>
      item.textContent?.includes(m.reporter_status_copy()),
    );
    await act(async () => {
      copy!.click();
    });
    await setSession({ ...original, csrfToken: 'replacement-browser-session' });
    absent();
    await setSession(original);
    await act(async () => copied());
    absent();
    expect(host.textContent).not.toContain(m.reporter_status_copied());

    // A current native transient failure offers exactly one explicit read per click and no automatic retry.
    await mount();
    status = 503;
    await refresh();
    expect(host.textContent).toContain(m.reporter_status_unavailable());
    absent();
    const before = calls.length;
    await flush();
    expect(calls).toHaveLength(before);
    status = 200;
    await retry();
    expect(calls).toHaveLength(before + 1);
    expect(host.textContent).toContain(report.evidence!);

    // Session replacement while a route read is pending cannot be undone by returning to the old session.
    gate = new Promise((resolve) => {
      release = resolve;
    });
    const pending = load();
    await flush();
    await setSession({ ...original, csrfToken: 'pending-replacement' });
    absent();
    await setSession(original);
    release!();
    const late = await pending;
    expect(late.result.state).toBe('concealed');
    gate = undefined;

    // Neither retry nor refresh can undo account replacement.
    for (const action of [retry, refresh]) {
      status = action === retry ? 503 : 200;
      await mount();
      status = 200;
      gate = new Promise((resolve) => {
        release = resolve;
      });
      await action();
      expect(host.textContent).toContain(m.reporter_status_read_loading());
      await setSession({ ...original, subject: 'different-reporter' });
      await setSession(original);
      release!();
      await flush();
      absent();
      gate = undefined;
    }

    for (const denial of [403, 404, 'closed'] as const) {
      status = 200;
      await mount();
      closed = denial === 'closed';
      status = typeof denial === 'number' ? denial : 403;
      await refresh();
      expect(host.textContent).toContain(closed ? m.reporter_status_read_closed() : m.reporter_status_read_concealed());
      expect(host.querySelector('button')).toBeNull();
      absent();
    }
    closed = false;
    status = 200;
    await mount();
    await setSession({ state: 'signed-out', subject: null, csrfToken: null });
    absent();
    await setSession(original);
    absent();
    await mount();
    await act(async () => root.render(null));
    expect(host.textContent).toBe('');
    expect(calls.every((call) => call === `GET /v1/reports/${id}`)).toBe(true);
  } finally {
    release?.();
    await act(async () => root.unmount());
    stopShell();
    cache.clear();
    mock.module('../src/moderation/reporter-status-read', () => ({ ...reader, readReporterStatus: originalRead }));
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('all native own target kinds preserve exact identity and disposition with translated labels and no target links', () => {
  for (const kind of ['board', 'thread', 'post', 'subject', 'space', 'realm'] as const) {
    for (const outcome of [null, 'actioned', 'dismissed'] as const) {
      const own = {
        ...submission,
        target: { kind, id: submission.target.id },
        outcome,
        resolvedAt: outcome ? '2026-10-31T10:00:00.000Z' : null,
      };
      expect(reporterStatusResponse({ report: own })).toEqual(own);
      const html = renderToStaticMarkup(createElement(ReporterStatusView, { report: own }));
      expect(html).toContain(`${kind} ${own.target.id}`);
      expect(html).not.toContain('href=');
      expect(() => reporterStatusResponse({ report: own, inspection: {} })).toThrow();
    }
  }
  for (const invalid of [
    { target: { kind: 'account', id: submission.target.id } },
    { target: { kind: 'realm', id: '' } },
    { id: '' },
    { reporterId: '' },
    { revisionId: 'not-an-id' },
    { createdAt: 'not-a-date' },
    { resolvedAt: 'not-a-date' },
    { outcome: 'reversed' },
    { reason: 'invented' },
    { evidence: 1 },
  ])
    expect(() => reporterStatusResponse({ report: { ...submission, ...invalid } })).toThrow();
});

test('Subject, Space and Realm status labels are readable in the retained journey locales', () => {
  const previous = getLocale();
  try {
    for (const [locale, labels] of [
      ['en', ['Subject', 'Space', 'Realm']],
      ['zh-Hant', ['條目', '空間', '領域']],
      ['ja', ['項目', 'スペース', 'レルム']],
    ] as const) {
      setLocale(locale, { reload: false });
      for (const [index, kind] of ['subject', 'space', 'realm'].entries()) {
        const report = reporterStatusResponse({
          report: { ...submission, target: { kind, id: submission.target.id } },
        });
        expect(renderToStaticMarkup(createElement(ReporterStatusView, { report }))).toContain(labels[index]!);
      }
    }
  } finally {
    setLocale(previous, { reload: false });
  }
});
