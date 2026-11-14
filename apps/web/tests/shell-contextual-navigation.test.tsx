import { afterAll, afterEach, expect, test } from 'bun:test';
import { act, createContext, StrictMode, useContext } from 'react';
import { Window } from 'happy-dom';
import type { Root } from 'react-dom/client';

const window = new Window({ url: 'https://shell.test/workspace' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  Element: window.Element,
  Node: window.Node,
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import('react-dom/client');
const { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } =
  await import('@tanstack/react-router');
const { ShellContextNavigation, ShellContextNavigationOutlet, ShellContextNavigationProvider } =
  await import('../src/shell/contextual-navigation');
let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  document.body.replaceChildren();
});
afterAll(async () => {
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await window.happyDOM.close();
});

type State = { label: string; admitted: boolean; surface: 'desktop' | 'phone' | 'closed'; parent: boolean };
const initial: State = { label: 'Current draft', admitted: true, surface: 'desktop', parent: false };
const State = createContext(initial);
const ReaderLabel = createContext('Missing reader context');
function Contents() {
  return <a href="#chapter">{useContext(ReaderLabel)}</a>;
}
function Workspace() {
  const { label, admitted } = useContext(State);
  return (
    <ReaderLabel value={`${label} chapter`}>
      {admitted && (
        <ShellContextNavigation label={label}>
          <Contents />
        </ShellContextNavigation>
      )}
      <textarea aria-label="Editor" defaultValue="Unsaved draft" />
    </ReaderLabel>
  );
}
function Frame() {
  const { surface, parent } = useContext(State);
  return (
    <ShellContextNavigationProvider>
      {surface !== 'closed' && (
        <nav key={surface} aria-label={surface}>
          <ShellContextNavigationOutlet />
        </nav>
      )}
      {parent && (
        <ShellContextNavigation label="Parent workspace">
          <a href="#parent">Parent chapter</a>
        </ShellContextNavigation>
      )}
      <main>
        <Outlet />
      </main>
    </ShellContextNavigationProvider>
  );
}
const region = () => document.querySelector<HTMLElement>('[data-shell-context-navigation]');
test('standalone declarations retain accessible local navigation without a Router or Shell', async () => {
  const host = document.createElement('main');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <ShellContextNavigation label="Local chapters">
        <Contents />
      </ShellContextNavigation>,
    ),
  );
  expect(host.contains(region())).toBe(true);
  expect(region()?.tagName).toBe('NAV');
  expect(document.getElementById(region()!.getAttribute('aria-labelledby')!)?.textContent).toBe('Local chapters');
  expect(region()!.querySelector('a')?.getAttribute('href')).toBe('#chapter');
});

async function mount() {
  const route = createRootRoute({ component: Frame });
  const router = createRouter({
    routeTree: route.addChildren([
      createRoute({ getParentRoute: () => route, path: '/workspace', component: Workspace }),
      createRoute({
        getParentRoute: () => route,
        path: '/other',
        component: () => (
          <ShellContextNavigation label="Other workspace">
            <a href="#other">Other chapter</a>
          </ShellContextNavigation>
        ),
      }),
      createRoute({ getParentRoute: () => route, path: '/plain', component: () => <p>Plain canvas</p> }),
    ]),
    history: createMemoryHistory({ initialEntries: ['/workspace'] }),
  });
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  let state = initial;
  const render = async (next: Partial<State> = {}) => {
    state = { ...state, ...next };
    await act(async () =>
      root!.render(
        <StrictMode>
          <State value={state}>
            <RouterProvider router={router} />
          </State>
        </StrictMode>,
      ),
    );
  };
  await act(async () => router.load());
  await render();
  return { render, router };
}

test('current props and reader context replace one region; admission and route removal erase old content', async () => {
  const { render, router } = await mount();
  expect(region()?.textContent).toBe('Current draftCurrent draft chapter');
  expect(document.querySelector('main')!.contains(region())).toBe(false);
  await render({ label: 'Replacement draft' });
  expect(document.querySelectorAll('[data-shell-context-navigation]')).toHaveLength(1);
  expect(region()?.textContent).toBe('Replacement draftReplacement draft chapter');
  await render({ admitted: false });
  expect(region()).toBeNull();
  await render({ admitted: true });
  await act(async () => router.navigate({ href: '/other' }));
  expect(region()?.textContent).toBe('Other workspaceOther chapter');
  expect(document.querySelectorAll('[data-shell-context-navigation]')).toHaveLength(1);
  expect(document.body.textContent).not.toContain('Replacement draft');
  await act(async () => router.navigate({ href: '/plain' }));
  expect(region()).toBeNull();
  expect(document.body.textContent).not.toContain('Replacement draft');
});

test('nested route ownership survives effect replay and host changes without remounting the editor', async () => {
  const { render, router } = await mount();
  const editor = document.querySelector('textarea')!;
  editor.value = 'Still unsaved';
  await render({ parent: true });
  expect(region()?.textContent).toBe('Current draftCurrent draft chapter');
  expect(document.body.textContent).not.toContain('Parent chapter');
  const chapter = region()!.querySelector('a')!;
  chapter.focus();
  await act(async () => router.navigate({ href: '/workspace?q=retained#chapter' }));
  expect(region()!.querySelector('a')).toBe(chapter);
  expect(document.activeElement).toBe(chapter);
  await render({ surface: 'closed' });
  expect(region()).toBeNull();
  await render({ surface: 'phone' });
  expect(document.querySelector('[aria-label="phone"]')!.contains(region())).toBe(true);
  expect(document.querySelectorAll('[data-shell-context-navigation]')).toHaveLength(1);
  await render({ surface: 'desktop' });
  expect(document.querySelector('[aria-label="desktop"]')!.contains(region())).toBe(true);
  expect(document.querySelectorAll('[data-shell-context-navigation]')).toHaveLength(1);
  expect(document.querySelector('textarea')).toBe(editor);
  expect(editor.value).toBe('Still unsaved');
  await act(async () => router.navigate({ href: '/plain' }));
  expect(region()?.textContent).toBe('Parent workspaceParent chapter');
  await render({ parent: false });
  expect(region()).toBeNull();
});
