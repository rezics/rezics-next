import { afterAll, expect, mock, test } from 'bun:test';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRouteWithContext, createRouter, RouterProvider } from '@tanstack/react-router';
import * as start from '../.storybook/react-start';
import {
  BulkOutcomeWindows,
  type LibraryBulkOperation,
  type LibraryBulkOutcome,
} from '../src/library/bulk-operation-recovery';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('../src/session/guard', () => ({ requireSignedIn: async () => {} }));
const { Window } = await import('happy-dom');
const operationId = '12345678-1234-4234-8234-123456789abc';
const otherId = '22345678-1234-4234-8234-123456789abc';
const window = new Window({ url: `https://site.test/library/operations/${operationId}` });
window.document.head.innerHTML = '<link rel="canonical" href="https://site.test">';
const globals = {
  scrollTo: window.scrollTo.bind(window),
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  Element: window.Element,
  Node: window.Node,
  Document: window.Document,
  MutationObserver: window.MutationObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
afterAll(async () => {
  mock.module('../src/library/bulk-operation-recovery-server', () => originalRecoveryServer);
  mock.restore();
  await window.happyDOM.close();
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
function operation(id: string): LibraryBulkOperation {
  return {
    id,
    route: 1,
    action: 'set_status',
    state: 'planned',
    collectionId: null,
    selectionKind: 'explicit',
    selectionSource: null,
    phase: 'applying',
    selectionComplete: true,
    occurrencesComplete: true,
    cancelRequested: false,
    counts: {
      scannedCandidates: 60,
      selectedSubjects: 60,
      scannedOccurrences: 0,
      capturedOccurrences: 0,
      targets: 60,
      pending: changed ? 0 : 60,
      reconciling: 0,
      applied: changed ? 60 : 0,
      no_effect: 0,
      conflict: 0,
      denied: 0,
      failed: 0,
      cancelled: 0,
    },
    summary: null,
    admittedAt: '2026-11-01T00:00:00Z',
    targetBoundAt: null,
    expiresAt: '2026-11-02T00:00:00Z',
    resultsExpireAt: '2026-11-03T00:00:00Z',
    finishedAt: null,
    reason: null,
  };
}
const originalRecoveryServer = { ...(await import('../src/library/bulk-operation-recovery-server')) };
const reads: Array<{ operationId: string; cursor?: string }> = [];
const commands: unknown[] = [];
let fail = false,
  invalid = false,
  changed = false;
let late: (() => Promise<void>) | undefined;
function page(cursor?: string) {
  const outcomes: LibraryBulkOutcome[] =
    cursor === 'c' || cursor === 'd'
      ? []
      : Array.from({ length: 20 }, (_, index) => ({
          ordinal: `${cursor ?? 'first'}-${index}`,
          subjectId: `subject-${cursor ?? 'first'}-${index}`,
          memberId: null,
          state: changed ? 'applied' : 'pending',
          reason: null,
          deletion: null,
          memberDeletion: null,
          resultingMemberId: null,
        }));
  return { outcomes, next: cursor === undefined ? 'b' : cursor === 'b' ? 'c' : cursor === 'c' ? 'd' : null };
}
mock.module('../src/library/bulk-operation-recovery-server', () => ({
  ...originalRecoveryServer,
  readBulkOperationRecovery: async ({ data }: { data: { operationId: string; cursor?: string } }) => {
    reads.push(data);
    return { state: 'available', operation: operation(data.operationId), ...page(data.cursor) };
  },
  readBulkOperationRecoveryPage: async ({ data }: { data: { operationId: string; cursor?: string } }) => {
    reads.push(data);
    if (late) await late();
    if (fail) {
      fail = false;
      return { state: 'unavailable', operationId: data.operationId };
    }
    if (invalid) {
      invalid = false;
      return { state: 'invalid', operationId: data.operationId };
    }
    return { state: 'available', page: page(data.cursor) };
  },
  captureBulkOperationCancel: async () => ({
    state: 'ready',
    csrfToken: 'csrf',
    intent: {
      operationId,
      sender: 'viewer',
      idempotencyKey: 'exact-key',
      locale: 'en',
      capture: 'sealed-command',
    },
  }),
  cancelBulkOperationRecovery: async (input: unknown) => {
    commands.push(input);
    return { state: 'uncertain', operationId };
  },
}));
const { Route } = await import('../src/routes/library/operations/$id');
const { createRoot } = await import('react-dom/client');
const { sessionQuery } = await import('../src/session/query');
const { viewerExposureLifetime, viewerExposureQuery } = await import('../src/kernel/viewer-exposure');
const { m } = await import('../src/paraglide/messages.js');

test('coordinates retain eight predecessors, commit only staged success and drop forward branches', () => {
  const path = new BulkOutcomeWindows();
  for (let i = 0; i < 12; i++) path.commit(path.stage('next', `cursor-${i}`));
  expect(path.predecessors).toHaveLength(8);
  const failed = path.stage('next', 'failed');
  expect(path.cursor).toBe('cursor-11');
  path.commit(path.stage('previous'));
  expect(path.commit(failed)).toBe(false);
  path.commit(path.stage('next', 'new-native-next'));
  expect(path.predecessors.at(-1)).toBe('cursor-10');
  path.commit(path.stage('first'));
  expect(path.cursor).toBeUndefined();
  expect(path.predecessors).toEqual([]);
});

test('production route replaces three windows, retries exact reads independently of captured cancellation and retires late disclosure', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const session = { state: 'signed-in', subject: 'viewer', csrfToken: 'csrf' };
  client.setQueryData(sessionQuery.queryKey, session);
  const lifetime = viewerExposureLifetime(client);
  const observe = () => {
    const snapshot = lifetime.getSnapshot();
    if (snapshot.state !== 'signed-in') throw new Error('missing viewer');
    client.setQueryData(viewerExposureQuery(snapshot.observation).queryKey, {
      subject: 'viewer',
      admitted: ['personal_library'],
    });
  };
  const stop = lifetime.subscribe(() => {});
  observe();
  const parent = createRootRouteWithContext<{ queryClient: QueryClient }>()();
  const route = Route.update({ getParentRoute: () => parent, path: '/library/operations/$id', id: undefined } as never);
  const router = createRouter({
    routeTree: parent.addChildren([route]),
    context: { queryClient: client },
    history: createMemoryHistory({ initialEntries: [`/library/operations/${operationId}`] }),
  });
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 25));
  const click = async (label: string) => {
    const button = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === label);
    expect(button).toBeDefined();
    await act(async () => {
      button!.focus();
      button!.click();
      await settle();
    });
  };
  try {
    await act(async () => {
      await router.load();
      root.render(
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      );
      await settle();
    });
    expect(host.querySelectorAll('ol li')).toHaveLength(20);
    await click(m.library_bulk_recovery_cancel());
    await click(m.library_bulk_recovery_read_more());
    expect(reads.at(-1)?.cursor).toBe('b');
    expect(host.querySelectorAll('ol li')).toHaveLength(20);
    fail = true;
    await click(m.library_bulk_recovery_read_more());
    await click(m.library_vndb_browse_refresh());
    expect(reads.at(-1)?.cursor).toBe('b');
    fail = true;
    await click(m.library_bulk_recovery_read_more());
    await click(m.library_bulk_recovery_read_again());
    expect(reads.slice(-2).map((r) => r.cursor)).toEqual(['c', 'c']);
    expect(host.querySelectorAll('ol li')).toHaveLength(0);
    await click(m.library_bulk_recovery_read_more());
    expect(reads.at(-1)?.cursor).toBe('d');
    expect(host.querySelectorAll('ol li')).toHaveLength(0);
    await click(m.library_window_previous());
    expect(reads.at(-1)?.cursor).toBe('c');
    await click(m.library_window_previous());
    expect(reads.at(-1)?.cursor).toBe('b');
    await click(m.library_window_previous());
    expect(reads.at(-1)?.cursor).toBeUndefined();
    await click(m.library_bulk_recovery_read_more());
    changed = true;
    await click(m.library_vndb_browse_refresh());
    expect(host.textContent).toContain(m.library_bulk_recovery_outcome_success());
    await click(m.library_window_first());
    expect(reads.at(-1)).toEqual({ operationId });
    await click(m.library_bulk_recovery_cancel_retry());
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(commands[0]);
    invalid = true;
    await click(m.library_bulk_recovery_read_more());
    expect(reads.at(-1)).toEqual({ operationId });
    let resolve!: () => void;
    const pending = new Promise<void>((r) => {
      resolve = r;
    });
    late = () => pending;
    await click(m.library_bulk_recovery_read_more());
    await act(async () => {
      client.setQueryData(sessionQuery.queryKey, { ...session, subject: 'other' });
      client.setQueryData(sessionQuery.queryKey, session);
      observe();
      resolve();
      await settle();
    });
    expect(host.textContent).not.toContain('subject-b-');
    late = undefined;
    await act(async () => {
      await router.navigate({ to: '/library/operations/$id', params: { id: otherId } });
      await settle();
    });
    await act(async () => {
      await settle();
    });
    expect(router.state.location.pathname).toBe(`/library/operations/${otherId}`);
    expect(host.textContent).not.toContain(m.library_bulk_recovery_address_pending());
    expect(reads.at(-1)?.operationId).toBe(otherId);
    expect(host.textContent).not.toContain('subject-b-');
  } finally {
    await act(async () => root.unmount());
    stop();
    client.clear();
    host.remove();
  }
});
