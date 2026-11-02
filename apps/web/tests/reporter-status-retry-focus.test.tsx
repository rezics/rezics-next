import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import type { ReporterStatusRead } from '../src/moderation/reporter-status-read-model';
import type { ReporterStatus } from '../src/moderation/reporter-status-model';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => (resolve = yes));
  return { promise, resolve };
}

const { Window } = await import(Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir))));
const window = new Window({ url: 'https://site.test/en/moderation/reports/0192f3a0-6c1e-7b2a-9d4e-000000000020' });
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

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { m } = await import('../src/paraglide/messages.js');
const { privateReaderFingerprint } = await import('../src/moderation/private-reader-origin');
const { prepareReporterStatusRead } = await import('../src/moderation/reporter-status-read-model');
const reader = await import('../src/moderation/reporter-status-read');
let origin: { subject: string; csrfFingerprint: string };
let calls = 0;
const retries = [deferred<ReporterStatusRead['result']>(), deferred<ReporterStatusRead['result']>(), deferred<ReporterStatusRead['result']>()];
mock.module('../src/moderation/reporter-status-read', () => ({
  ...reader,
  readReporterStatus: ({ data }: { data: { id: string; generation: string } }) =>
    retries[calls++]!.promise.then((result) => ({
      id: data.id,
      generation: data.generation,
      viewer: origin,
      readerOrigin: origin,
      result,
    })),
}));
const { ReporterStatusCurrent } = await import('../src/moderation/reporter-status-view');

test('a keyboard retry keeps the current result boundary and leaves moved focus alone', async () => {
  const report: ReporterStatus = {
    id: '0192f3a0-6c1e-7b2a-9d4e-000000000020',
    target: { kind: 'post', id: '0192f3a0-6c1e-7b2a-9d4e-000000000012' },
    revisionId: null,
    reason: 'other',
    evidence: 'Own submitted evidence',
    reporterId: '0192f3a0-6c1e-7b2a-9d4e-000000000001',
    createdAt: '2026-10-28T10:00:00.000Z',
    resolvedAt: null,
    outcome: null,
    targetAvailability: 'unavailable',
  };
  const token = 'reporter-status-focus-session';
  origin = { subject: report.reporterId, csrfFingerprint: await privateReaderFingerprint(token) };
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  cache.setQueryData(['session'], { state: 'signed-in', subject: origin.subject, csrfToken: token });
  const initial = await prepareReporterStatusRead(cache, report.id, async ({ id, generation }) => ({
    id,
    generation,
    viewer: origin,
    readerOrigin: origin,
    result: { state: 'unavailable' as const },
  }));
  const host = document.createElement('main');
  const elsewhere = document.createElement('button');
  elsewhere.textContent = 'Elsewhere';
  document.body.append(elsewhere, host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <QueryClientProvider client={cache}>
        <ReporterStatusCurrent initial={initial} />
      </QueryClientProvider>,
    ),
  );
  const retry = () => [...host.querySelectorAll('button')].find((button) => button.textContent?.includes(m.sources_retry()))!;
  const startRetry = async () =>
    act(async () => {
      retry().focus();
      retry().click();
    });
  const settle = async (index: number, result: ReporterStatusRead['result']) =>
    act(async () => {
      retries[index]!.resolve(result);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

  expect(document.activeElement).not.toBe(host.querySelector('h1'));
  await startRetry();
  await settle(0, { state: 'unavailable' });
  expect(document.activeElement).toBe(host.querySelector('h1'));
  expect(retry()).toBeTruthy();

  await startRetry();
  await act(async () => elsewhere.focus());
  await settle(1, { state: 'unavailable' });
  expect(document.activeElement).toBe(elsewhere);
  expect(retry()).toBeTruthy();

  await startRetry();
  await settle(2, { state: 'loaded', report });
  expect(document.activeElement).toBe(host.querySelector('h1'));
  expect(host.textContent).toContain(report.evidence);
  expect(host.textContent).toContain(m.moderation_target_unavailable());
  expect(host.querySelectorAll('a')).toHaveLength(1);
  expect(calls).toBe(3);
  await act(async () => root.unmount());
  cache.clear();
  host.remove();
  elsewhere.remove();
});
