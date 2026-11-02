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
  readProgressChoices: request,
  readCurrentViewerProgressIndex: request,
}));
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { createRoot } = await import('react-dom/client');
const { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } =
  await import('@tanstack/react-router');
const { ProgressIndexPage } = await import('../src/library/progress-page');
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
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ['/en/library/progress'] }),
  });
  await router.load();
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const view = within(host);
  const user = userEvent.setup({ document });
  const subject = { ...profileSession.subject, typeLabel: 'Journey' };
  const page: ProgressIndex = {
    signedIn: true,
    subjectId: '',
    selectedSubject: null,
    sessions: [],
    next: null,
    idempotencyKey: crypto.randomUUID(),
  };
  const render = async (state: 'active' | 'completed', disclosed = true) => {
    const session = { ...profileSession, state, subject: disclosed ? subject : null };
    await tick(() =>
      root.render(
        <QueryClientProvider client={client}>
          <RouterContextProvider router={router}>
            <ProgressIndexPage page={{ ...page, sessions: [session] }} />
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
      expect(menu()!.className).toContain('min-h-[44px]');
      expect(menu()!.className).toContain('min-w-[44px]');
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
    expect(request).not.toHaveBeenCalled();
  } finally {
    await tick(() => root.unmount());
    host.remove();
    client.clear();
  }
});
