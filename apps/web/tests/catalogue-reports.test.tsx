import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { createKernelClient } from '@rezics/client';
import type { CatalogueReport } from '../src/moderation/catalogue-reports-read';

mock.module('cloudflare:workers', () => ({ env: {} }));

const { Window } = await import(Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir))));
const window = new Window({ url: 'https://site.test/en/moderation/catalogue' });
for (const [key, value] of Object.entries({
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  Element: window.Element,
  Node: window.Node,
  MutationObserver: window.MutationObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
}))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { m } = await import('../src/paraglide/messages.js');
const { privateReaderFingerprint } = await import('../src/moderation/private-reader-origin');
const {
  catalogueReportsReadKey,
  prepareCatalogueReportsRead,
  readCatalogueReports,
  readCatalogueSubject,
} = await import('../src/moderation/catalogue-reports-read');
const { sendCatalogueReportAction } = await import('../src/moderation/catalogue-reports-actions');
const { CatalogueReportsCurrent } = await import('../src/moderation/catalogue-reports-page');
const { createCatalogueReportsJourney } = await import('../src/moderation/catalogue-reports-journey');
const { submitReport, validateReport } = await import('../src/report/submit.server');

const id = (number: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(number).padStart(12, '0')}`;
const reportId = id(401);
const subjectId = id(301);
const reporterId = id(777);
const moderatorId = id(701);
const token = 'catalogue-moderator-session';
const authorization = 'Bearer current-global-moderator';
const idempotencyKey = '0192f3a0-6c1e-4b2a-9d4e-000000000801';
const report = {
  id: reportId,
  partition: 1,
  target: { kind: 'subject' as const, id: subjectId },
  revisionId: null,
  reason: 'other',
  evidence: 'Private evidence for the report.',
  createdAt: '2026-10-28T10:00:00.000Z',
  outcome: null,
  resolvedAt: null,
  transactionId: 'native-transaction-reference',
  reporterId,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => (resolve = yes));
  return { promise, resolve };
}

function nativeClient(handler: (request: Request) => Response | Promise<Response>) {
  const requests: Array<{ method: string; url: URL; headers: Headers; body: string }> = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      const record = {
        method: request.method,
        url: new URL(request.url),
        headers: new Headers(request.headers),
        body: await request.clone().text(),
      };
      requests.push(record);
      return handler(request);
    }) as typeof fetch,
  });
  return { client, requests };
}

async function privateCache(subject = moderatorId, csrfToken = token) {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  cache.setQueryData(['session'], { state: 'signed-in', subject, csrfToken });
  return {
    cache,
    origin: { subject, csrfFingerprint: await privateReaderFingerprint(csrfToken) },
  };
}

async function preparedPage(
  cache: InstanceType<typeof QueryClient>,
  origin: { subject: string; csrfFingerprint: string },
  reports: CatalogueReport[] = [report],
  next: string | null = null,
) {
  return prepareCatalogueReportsRead(cache, undefined, async () => ({
    cursor: null,
    readerOrigin: origin,
    result: { state: 'loaded' as const, reports, next },
  }));
}

async function mountCurrent(
  cache: InstanceType<typeof QueryClient>,
  initial: Awaited<ReturnType<typeof preparedPage>>,
  options: {
    readSubject: (id: string) => Promise<Awaited<ReturnType<typeof readCatalogueSubject>>>;
    action: (input: Parameters<typeof sendCatalogueReportAction>[1]) => Promise<Awaited<ReturnType<typeof sendCatalogueReportAction>>>;
    next?: (cursor: string) => void;
  },
) {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const pageReader = async (input: { cursor?: string }) =>
    prepareCatalogueReportsRead(cache, input.cursor, async () => ({
      cursor: input.cursor ?? null,
      readerOrigin: initial.readerOrigin,
      result: {
        state: 'loaded' as const,
        reports: initial.result.state === 'loaded' ? initial.result.reports : [],
        next: null,
      },
    }));
  const readSubject = options.readSubject;
  const action = options.action;
  await act(async () =>
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: cache },
        React.createElement(CatalogueReportsCurrent, {
          initial,
          readPage: pageReader,
          readSubject,
          action,
          onNext: options.next ?? (() => {}),
          onRestart: () => {},
        }),
      ),
    ),
  );
  await act(async () => Promise.resolve());
  return {
    host,
    root,
    cleanup: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

function button(host: HTMLElement, label: string) {
  return [...host.querySelectorAll('button')].find((item) => item.textContent?.includes(label));
}

test('Subject report submission uses the delivered native target and returns the real reporter receipt id', async () => {
  const { client, requests } = nativeClient(async (request) =>
    request.method === 'POST' && new URL(request.url).pathname === '/v1/reports'
      ? Response.json({ reportId }, { status: 201 })
      : Response.json({}, { status: 404 }),
  );
  const draft = validateReport({
    target: { kind: 'subject', id: subjectId },
    reason: 'other',
    evidence: 'A reader supplied this evidence.',
    botToken: 'turnstile-token',
    idempotencyKey,
  });
  const receipt = await submitReport(new Request('https://site.test/en/subjects/example'), {}, draft, client);
  expect(receipt).toEqual({ ok: true, reportId });
  expect(JSON.parse(requests[0]!.body)).toMatchObject({ target: { kind: 'subject', id: subjectId }, evidence: draft.evidence });
  expect(requests[0]!.headers.get('idempotency-key')).toBe(JSON.stringify(idempotencyKey));
});

test('catalogue and current Subject reads use native response shapes, exact continuation and no reporter identity', async () => {
  const cursor = 'sealed cursor/+ with exact bytes';
  const { client, requests } = nativeClient(async (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/v1/catalogue/reports') return Response.json({ reports: [report], next: 'next-native-cursor' });
    if (url.pathname === `/v1/subjects/${subjectId}/reports`) return Response.json({ reports: [report], next: null });
    if (url.pathname === `/v1/subjects/${subjectId}`)
      return Response.json({ subject: { id: subjectId, type: 'schema:Thing', labels: { en: 'Current entry' }, descriptions: { en: 'Current Subject description.' }, aliases: {}, statements: {}, sourceRecords: [], revision: 1, release: 'released', context: 'global', resolution: {}, relationCounts: {} }, account: null, summary: {}, related: {} });
    return Response.json({}, { status: 404 });
  });
  const origin = { subject: moderatorId, csrfFingerprint: 'current-reader-fingerprint' };
  const page = await readCatalogueReports(client, { cursor }, authorization, origin);
  const current = await readCatalogueSubject(client, subjectId, reportId, authorization, origin);
  expect(page.result).toMatchObject({ state: 'loaded', reports: [{ id: reportId, evidence: report.evidence }], next: 'next-native-cursor' });
  expect(JSON.stringify(page)).not.toContain(reporterId);
  expect(requests[0]!.url.searchParams.get('limit')).toBe('50');
  expect(requests[0]!.url.searchParams.get('cursor')).toBe(cursor);
  expect(current.result).toMatchObject({ state: 'loaded', subject: { id: subjectId, label: 'Current entry', description: 'Current Subject description.', type: 'schema:Thing' }, report: { id: reportId, outcome: null } });
  expect(requests.find((request) => request.url.pathname === `/v1/subjects/${subjectId}`)?.url.pathname).toBe(`/v1/subjects/${subjectId}`);
  const subjectReports = requests.find((request) => request.url.pathname === `/v1/subjects/${subjectId}/reports`)!;
  expect(subjectReports.url.searchParams.get('limit')).toBe('50');
  expect(subjectReports.url.searchParams.get('order')).toBe('newest');
  expect(requests.every((request) => request.headers.get('authorization') === authorization)).toBe(true);
  expect(catalogueReportsReadKey(cursor)).not.toBe(catalogueReportsReadKey('next-native-cursor'));
});

test('dismissal and Subject visibility adapters expose only native confirmed receipts and keep lost writes uncertain', async () => {
  const { client, requests } = nativeClient(async (request) => {
    const url = new URL(request.url);
    if (url.pathname.includes(reportId)) return Response.json({ reportId, outcome: 'dismissed' });
    if (url.pathname.includes(subjectId)) return Response.json({ subject: subjectId, visibility: 'hidden', security_revision: 2 });
    return Response.json({}, { status: 404 });
  });
  const dismissed = await sendCatalogueReportAction(
    client,
    { action: 'dismiss', reportId, subjectId, idempotencyKey },
    authorization,
  );
  const hidden = await sendCatalogueReportAction(
    client,
    { action: 'hide', reportId, subjectId, reason: 'The public entry exposes personal data.', idempotencyKey },
    authorization,
  );
  const lost = createKernelClient('https://kernel.test', { fetch: (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch });
  const uncertain = await sendCatalogueReportAction(
    lost,
    { action: 'restore', reportId, subjectId, reason: 'The subject is safe to show again.', idempotencyKey },
    authorization,
  );
  expect(dismissed).toEqual({ ok: true, result: { kind: 'dismissed', reportId, outcome: 'dismissed' } });
  expect(hidden).toEqual({ ok: true, result: { kind: 'visibility', subjectId, visibility: 'hidden' } });
  expect(uncertain).toEqual({ ok: false, state: 'uncertain' });
  expect(requests[0]!.headers.get('idempotency-key')).toBe(JSON.stringify(idempotencyKey));
  expect(JSON.parse(requests[1]!.body)).toEqual({ reason: 'The public entry exposes personal data.' });
});

test('mounted queue forwards the exact next cursor and retries an uncertain dismissal with the same command key', async () => {
  const { cache, origin } = await privateCache();
  const initial = await preparedPage(cache, origin, [report], 'native-cursor / exact');
  const calls: Array<Parameters<typeof sendCatalogueReportAction>[1]> = [];
  const action = async (input: Parameters<typeof sendCatalogueReportAction>[1]) => {
    calls.push(input);
    return calls.length === 1
      ? ({ ok: false, state: 'uncertain' } as const)
      : ({ ok: true, result: { kind: 'dismissed', reportId, outcome: 'dismissed' } } as const);
  };
  let continued = '';
  const mounted = await mountCurrent(cache, initial, {
    readSubject: async (id) => ({ subjectId: id, readerOrigin: origin, result: { state: 'loaded', subject: { id, label: 'Readable Subject', description: null, type: 'schema:Thing' } } }),
    action,
    next: (cursor) => (continued = cursor),
  });
  try {
    await act(async () => button(mounted.host, m.threads_next_page())?.click());
    expect(continued).toBe('native-cursor / exact');
    await act(async () => button(mounted.host, m.moderation_dismiss())?.click());
    expect(mounted.host.textContent).toContain(m.moderation_queue_uncertain());
    await act(async () => button(mounted.host, m.moderation_queue_retry_action())?.click());
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect(calls[0]!.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/iu);
    expect(mounted.host.textContent).toContain(m.moderation_dismissed());
  } finally {
    await mounted.cleanup();
  }
});

test('viewer retirement clears mounted evidence and rejects a late target read or stale action', async () => {
  const { cache, origin } = await privateCache();
  const initial = await preparedPage(cache, origin);
  let actions = 0;
  const staleButtonAction = async () => {
    actions++;
    return { ok: true as const, result: { kind: 'dismissed' as const, reportId, outcome: 'dismissed' as const } };
  };
  const mounted = await mountCurrent(cache, initial, {
    readSubject: async (id) => ({ subjectId: id, readerOrigin: origin, result: { state: 'loaded', subject: { id, label: 'Current Subject', description: null, type: 'schema:Thing' } } }),
    action: staleButtonAction,
  });
  const oldDismissButton = button(mounted.host, m.moderation_dismiss());
  try {
    expect(mounted.host.textContent).toContain(report.evidence);
    await act(async () => {
      cache.setQueryData(['session'], {
        state: 'signed-in',
        subject: id(702),
        csrfToken: 'replacement-credential',
      });
      oldDismissButton?.click();
    });
    expect(actions).toBe(0);
    expect(mounted.host.textContent).not.toContain(report.evidence);
    expect(mounted.host.textContent).toContain(m.moderation_queue_read_denied());
  } finally {
    await mounted.cleanup();
  }
});

test('a late current Subject response cannot restore evidence after viewer replacement', async () => {
  const { cache, origin } = await privateCache();
  const initial = await preparedPage(cache, origin);
  const held = deferred<Awaited<ReturnType<typeof readCatalogueSubject>>>();
  const mounted = await mountCurrent(cache, initial, {
    readSubject: () => held.promise,
    action: async () => ({ ok: false, state: 'unavailable' }),
  });
  try {
    expect(mounted.host.textContent).toContain(report.evidence);
    await act(async () => {
      cache.setQueryData(['session'], { state: 'signed-in', subject: id(702), csrfToken: 'replacement-credential' });
    });
    expect(mounted.host.textContent).not.toContain(report.evidence);
    await act(async () => {
      held.resolve({
        subjectId,
        readerOrigin: origin,
        result: { state: 'loaded', subject: { id: subjectId, label: 'Late private Subject', description: null, type: 'schema:Thing' } },
      });
      await Promise.resolve();
    });
    expect(mounted.host.textContent).not.toContain('Late private Subject');
    expect(mounted.host.textContent).not.toContain(report.evidence);
  } finally {
    await mounted.cleanup();
  }
});

test('restoring current Subject visibility leaves an actioned report actioned', async () => {
  const actioned = { ...report, outcome: 'actioned' as const, resolvedAt: '2026-10-28T11:00:00.000Z' };
  const { cache, origin } = await privateCache();
  const initial = await preparedPage(cache, origin, [actioned]);
  let command: Parameters<typeof sendCatalogueReportAction>[1] | undefined;
  const journey = createCatalogueReportsJourney({
    cache,
    initial,
    readPage: async () => initial,
    readSubject: async (id) => ({ subjectId: id, readerOrigin: origin, result: { state: 'unavailable' } }),
    action: async (input) => {
      command = input;
      return { ok: true, result: { kind: 'visibility', subjectId, visibility: 'visible' } };
    },
  });
  journey.changeReason('The current entry can be restored.');
  journey.act('restore');
  await act(async () => Promise.resolve());
  expect(command?.action).toBe('restore');
  expect(journey.snapshot()).toMatchObject({
    state: 'loaded',
    reports: [{ id: reportId, outcome: 'actioned' }],
    subject: { state: 'changed', visibility: 'visible' },
  });
  journey.retire();
});
