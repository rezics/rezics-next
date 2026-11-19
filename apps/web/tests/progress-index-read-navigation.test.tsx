import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, type ReactNode } from 'react';
import { profileSession } from '../src/kernel/fake/progress-profiles';
import type { ProgressIndex } from '../src/library/progress-reads';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://rezics.test/en/library/progress' });
const keys = [
  'document',
  'navigator',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLButtonElement',
  'Element',
  'Node',
  'NodeFilter',
  'Document',
  'ShadowRoot',
  'DocumentFragment',
  'MutationObserver',
  'ResizeObserver',
  'Event',
  'MouseEvent',
  'PointerEvent',
  'KeyboardEvent',
  'FocusEvent',
  'CSS',
] as const;
const globals = {
  window,
  ...Object.fromEntries(keys.map((key) => [key, window[key]])),
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
afterAll(async () => {
  mock.restore();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await window.happyDOM.close();
});

const operations = new Set<string>();
mock.module('../src/kernel/exposure', () => ({
  useOperation: (operation: string) => operations.has(operation),
  useOperationAdmission: (operation: string) => (operations.has(operation) ? 'available' : 'denied'),
  operationIsAdmitted: (operation: string, admitted?: readonly string[]) => admitted?.includes(operation) ?? false,
  Exposure: ({ operation, children }: { operation: string; children: ReactNode }) =>
    operations.has(operation) ? children : null,
}));
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => import('../.storybook/react-start'));
mock.module('@tanstack/react-start/server', () => import('../.storybook/react-start'));
mock.module('@rezics/ui/entity-picker', () => ({ EntityPicker: () => null }));
const request = mock(() => {
  throw new Error('Opening a disclosed destination must not request data');
});
mock.module('../src/library/progress-server', () => ({
  startProgressSession: request,
  finishProgressSession: request,
  recordProgressSession: request,
  readProgressSession: request,
  readProgressDetail: request,
  readProgressChoices: request,
  readCurrentViewerProgressIndex: request,
}));
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { createRoot } = await import('react-dom/client');
const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterContextProvider } =
  await import('@tanstack/react-router');
const { ProgressIndexPage } = await import('../src/library/progress-page');
const { LibraryApplicationContext } = await import('../src/library/application');
const { libraryApplication } = await import('../src/session/library-application');
const {
  progressIndexSelectionLocationState,
  progressReturnContextFromLocationState,
  progressReturnLocationState,
  progressIndexReturnSelectionFromLocationState,
} = await import('../src/library/progress-start-draft-navigation');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');
const { subjectHref } = await import('../src/subject/subject-href');
const { within, userEvent } = await import('storybook/test');
const tick = (run: () => unknown) =>
  act(async () => {
    await run();
  });

test('disclosed Subject navigation survives read-only active and completed rows; actions and detail keep separate admission', async () => {
  setLocale('en', { reload: false });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/en/library/progress',
    component: () => null,
  });
  const detailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/en/library/progress/$id',
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, detailRoute]),
    history: createMemoryHistory({ initialEntries: ['/en/library/progress'] }),
  });
  await router.load();
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const view = within(host);
  const user = userEvent.setup({ document });
  const subject = { ...profileSession.subject, typeLabel: 'Journey' };
  const continued = 'cursor/+?== &記録';
  const sourceReturnTo = '/en/library/continue?cursor=original%2B%2F';
  const windowCoordinates = { predecessors: [null, 'prior/opaque'], current: continued };
  const page: ProgressIndex = {
    signedIn: true,
    subjectId: '',
    selectedSubject: null,
    sessions: [],
    next: null,
    idempotencyKey: crypto.randomUUID(),
  };
  const render = async (
    state: 'active' | 'completed',
    disclosed = true,
    options: {
      cursor?: string;
      returnSelection?: ReturnType<typeof progressIndexReturnSelectionFromLocationState>;
    } = {},
    row = profileSession,
  ) => {
    const session = { ...profileSession, state, subject: disclosed ? subject : null };
    await tick(() =>
      root.render(
        <QueryClientProvider client={client}>
          <RouterContextProvider router={router}>
            <LibraryApplicationContext value={libraryApplication}>
              <ProgressIndexPage
                page={{ ...page, sessions: [row === profileSession ? session : row], subjectId: row.subjectId }}
                cursor={options.cursor}
                returnSelection={options.returnSelection}
                sourceReturnTo={sourceReturnTo}
                windowCoordinates={options.cursor === continued ? windowCoordinates : undefined}
              />
            </LibraryApplicationContext>
          </RouterContextProvider>
        </QueryClientProvider>,
      ),
    );
  };
  const menu = () => view.queryByRole('button', { name: m.library_collection_actions(), exact: true });
  const open = async () => {
    menu()!.focus();
    await tick(() => user.keyboard('{Enter}'));
  };
  const close = () => tick(() => user.keyboard('{Escape}'));
  try {
    operations.clear();
    for (const state of ['active', 'completed'] as const) {
      await render(state);
      expect(host.querySelector('[data-content-item-primary]')).toBeNull();
      expect(menu()).not.toBeNull();
      expect(menu()!.classList.contains('size-6')).toBe(true);
      expect(menu()!.classList.contains('max-md:hitbox-[11px]')).toBe(true);
      expect(menu()!.classList.contains('pointer-coarse:hitbox-[11px]')).toBe(true);
      await open();
      const destination = within(document.body).getByRole('menuitem', { name: m.library_progress_open_subject() });
      expect(destination.getAttribute('href')).toBe(subjectHref({ id: subject.id, label: subject.label }, 'en').href);
      expect(
        within(document.body).queryByRole('menuitem', { name: m.library_progress_complete(), exact: true }),
      ).toBeNull();
      expect(
        within(document.body).queryByRole('menuitem', { name: m.library_progress_abandon(), exact: true }),
      ).toBeNull();
      await close();
    }
    await render('active', false);
    expect(menu()).toBeNull();
    for (const action of ['complete', 'abandon'] as const) {
      operations.clear();
      operations.add(`progress_session.${action}`);
      operations.add('progress_session.read');
      await render('active', false);
      expect(host.querySelector(`a[href="/en/library/progress/${profileSession.id}"]`)).not.toBeNull();
      await open();
      const items = within(document.body).getAllByRole('menuitem');
      expect(items.map((item) => item.textContent)).toEqual([
        action === 'complete' ? m.library_progress_complete() : m.library_progress_abandon(),
      ]);
      await close();
      await render('completed', false);
      expect(menu()).toBeNull();
    }
    operations.add('progress_session.read');
    await render('active', true, { cursor: continued });
    const sessionLink = host.querySelector<HTMLAnchorElement>(`a[href="/en/library/progress/${profileSession.id}"]`)!;
    expect(sessionLink.href).toBe(`https://rezics.test/en/library/progress/${profileSession.id}`);
    await tick(() => sessionLink.click());
    expect(router.history.location.href).toBe(`/en/library/progress/${profileSession.id}`);
    const returnContext = progressReturnContextFromLocationState(
      router.history.location.state,
      profileSession.id,
      'en',
    );
    const indexAddress = new URL(returnContext!.indexHref, window.location.href);
    expect(indexAddress.pathname).toBe('/en/library/progress');
    expect(indexAddress.searchParams.get('cursor')).toBe(continued);
    expect(returnContext?.sourceReturnTo).toBe(sourceReturnTo);
    expect(returnContext?.subjectId).toBe(profileSession.subjectId);
    expect(returnContext?.startedAt).toBe(profileSession.startedAt);
    expect(returnContext?.windowCoordinates).toEqual({ predecessors: [null, 'prior/opaque'], current: continued });
    expect(Object.keys(returnContext?.windowCoordinates ?? {})).toEqual(['predecessors', 'current']);
    expect(router.history.location.state).toHaveProperty('progressReturn');
    expect(router.history.location.state).not.toHaveProperty('progressReturn.sessions');

    const selection = progressIndexReturnSelectionFromLocationState(
      progressIndexSelectionLocationState(returnContext!, profileSession.startedAt),
      'en',
    );
    expect(selection?.indexSearch?.cursor).toBe(continued);
    expect(selection?.sourceReturnTo).toBe(sourceReturnTo);
    expect(selection?.windowCoordinates).toEqual({ predecessors: [null, 'prior/opaque'], current: continued });
    const oversizedSelection = progressIndexReturnSelectionFromLocationState(
      {
        progressReturnSelection: {
          ...progressIndexSelectionLocationState(returnContext!, profileSession.startedAt).progressReturnSelection,
          windowCoordinates: { predecessors: Array(9).fill('old'), current: continued },
        },
      },
      'en',
    );
    expect(oversizedSelection?.windowCoordinates).toBeUndefined();
    await render('active', true, { cursor: continued, returnSelection: selection });
    expect(window.document.activeElement).toBe(host.querySelector('[data-progress-session-id]'));

    const changedIncarnation = { ...profileSession, startedAt: '2026-11-01T00:00:00Z', subject };
    await render('active', true, { cursor: continued, returnSelection: selection }, changedIncarnation);
    expect(view.getByText(m.library_progress_discovery_stale())).toBeDefined();
    const firstPage = view.getByRole('link', { name: m.library_collections_first_page() });
    expect(new URL(firstPage.getAttribute('href')!, window.location.href).searchParams.has('cursor')).toBe(false);
    const changedState = progressReturnLocationState(returnContext!);
    expect(progressReturnContextFromLocationState(changedState, profileSession.id, 'ja')).toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  } finally {
    await tick(() => root.unmount());
    router.history.destroy();
    host.remove();
    client.clear();
  }
});
