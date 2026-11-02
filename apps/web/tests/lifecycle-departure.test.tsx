import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act, useState } from 'react';
import type { Intent, Outcome, Page } from '../src/accounts/lifecycle-controls/data';

test('lifecycle departure preserves review on Stay, retires local work on Leave and revokes replaced authority', async () => {
  const { Window } = await import(Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir))));
  const window = new Window({ url: 'https://site.test/' });
  const globals = { window, document: window.document, navigator: window.navigator, HTMLElement: window.HTMLElement,
    HTMLFormElement: window.HTMLFormElement, Element: window.Element, Node: window.Node, Document: window.Document,
    DocumentFragment: window.DocumentFragment, MutationObserver: window.MutationObserver, ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window), requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window), IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } = await import('@tanstack/react-router');
  const { AuthoringDepartureProvider } = await import('../src/threads/authoring-departure');
  const { AccountLifecyclePage } = await import('../src/accounts/lifecycle-controls/page');
  const { sessionQuery } = await import('../src/session/query');
  const { m } = await import('../src/paraglide/messages.js');
  const require = createRequire(createRequire(import.meta.url).resolve('storybook/test'));
  const { default: userEvent } = await import(require.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  const client = new QueryClient();
  const session = { state: 'signed-in' as const, subject: 'operator', csrfToken: 'original' };
  client.setQueryData(sessionQuery.queryKey, session);
  const ready: Page = { status: 'ready', account: { id: '01a1a000-0000-7000-8000-000000000101', kind: 'actor', displayName: 'Reader', handle: 'reader' }, offered: ['suspend', 'reinstate'], currentState: 'unavailable' };
  let replace!: (page: Page) => void;
  let finish!: (outcome: Outcome) => void;
  const commands: Intent[] = [];
  const signals: AbortSignal[] = [];
  const io = { read: async () => ready, change: (intent: Intent, signal: AbortSignal) => {
    commands.push(intent); signals.push(signal); return new Promise<Outcome>((resolve) => { finish = resolve; });
  } };
  const base = createRootRoute({ component: Outlet });
  const home = createRoute({ getParentRoute: () => base, path: '/', component: () => {
    const [initial, setInitial] = useState(ready); replace = setInitial;
    return <AuthoringDepartureProvider sessionBound={false}><AccountLifecyclePage initial={initial} io={io} /></AuthoringDepartureProvider>;
  } });
  const away = createRoute({ getParentRoute: () => base, path: '/away', component: () => <p>Away</p> });
  const router = createRouter({ routeTree: base.addChildren([home, away]), history: createMemoryHistory({ initialEntries: ['/'] }) });
  const host = document.createElement('main'); document.body.append(host);
  const root = createRoot(host);
  const click = async (label: string) => act(async () => user.click([...document.querySelectorAll('button')].find((node) => node.textContent?.trim() === label)!));
  const settle = async (condition: () => boolean) => {
    for (let n = 0; n < 100 && !condition(); n++) await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 10)); });
    expect(condition()).toBe(true);
  };
  const navigate = () => act(async () => { void router.navigate({ to: '/away' }); });
  const back = async () => { await act(async () => { await router.navigate({ to: '/' }); }); await settle(() => !!host.querySelector('textarea')); };
  const blocked = () => { const event = new window.Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; };
  const dialog = () => document.querySelector('[role="alertdialog"]');
  const draft = async () => act(async () => user.type(host.querySelector('textarea')!, '  private reason  '));
  try {
    await act(async () => { await router.load(); root.render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>); });
    await settle(() => !!host.querySelector('textarea'));
    host.querySelector('textarea')!.focus(); expect(blocked()).toBe(false);
    await draft();
    await act(async () => user.selectOptions(host.querySelector('select')!, 'reinstate'));
    expect(blocked()).toBe(true);
    const reason = host.querySelector('textarea')!; reason.focus();
    await navigate(); await settle(() => !!dialog());
    expect(document.querySelectorAll('[role="alertdialog"]')).toHaveLength(1);
    expect(dialog()!.textContent).toContain(m.lifecycle_leave_unsaved());
    await click(m.thread_authoring_stay()); await settle(() => !dialog() && document.activeElement === reason);
    expect(reason.value).toBe('  private reason  ');
    expect(host.querySelector('select')!.value).toBe('reinstate');
    await click(m.lifecycle_review());
    const confirmation = host.querySelector('section')!.textContent;
    await navigate(); await settle(() => !!dialog()); await click(m.thread_authoring_stay());
    expect(host.querySelector('section')!.textContent).toBe(confirmation);
    await click(m.lifecycle_confirm());
    await navigate(); await settle(() => !!dialog());
    expect(dialog()!.textContent).toContain(m.container_lifecycle_leave_pending());
    await click(m.thread_authoring_stay());
    expect(commands).toHaveLength(1); expect(commands[0]!.reason).toBe('  private reason  ');
    expect(host.querySelector('section')!.textContent).toContain(commands[0]!.key);
    await act(async () => finish({ status: 'uncertain', current: ready }));
    await click(m.lifecycle_read_current()); await click(m.lifecycle_retry_same());
    expect(commands[1]).toBe(commands[0]);
    await navigate(); await settle(() => !!dialog()); await click(m.thread_authoring_leave());
    await settle(() => router.state.location.pathname === '/away'); expect(signals[1]!.aborted).toBe(true);
    await back(); await draft();
    await act(async () => finish({ status: 'recorded', receiptId: 'late', current: ready }));
    expect(host.querySelector('textarea')!.value).toBe('  private reason  ');
    expect(host.textContent).not.toContain('late');
    await click(m.lifecycle_review()); await click(m.lifecycle_confirm());
    await act(async () => finish({ status: 'recorded', receiptId: 'complete', current: ready, effects: {
      state: 'complete', operator: 'complete', sessionRevocation: 'not_required', sessionRevocationAuthorization: 'not_required', accountAgentSynchronization: 'unknown', inspectedPages: 0, terminalSubjects: 0,
    } }));
    expect(blocked()).toBe(false); await navigate(); await settle(() => router.state.location.pathname === '/away');
    await back(); await draft(); await navigate(); await settle(() => !!dialog());
    await act(async () => client.setQueryData(sessionQuery.queryKey, { ...session, csrfToken: 'replacement' }));
    await settle(() => router.state.location.pathname === '/away' && !dialog());
    await back(); await draft();
    await act(async () => replace({ ...ready, account: { ...ready.account, id: '01a1a000-0000-7000-8000-000000000102' } }));
    expect(host.querySelector('textarea')!.value).toBe(''); expect(blocked()).toBe(false);
    await draft(); await navigate(); await settle(() => !!dialog());
    await act(async () => replace({ status: 'denied' }));
    await settle(() => router.state.location.pathname === '/away' && !dialog());
  } finally {
    await act(async () => root.unmount()); client.clear(); host.remove(); await window.happyDOM.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
