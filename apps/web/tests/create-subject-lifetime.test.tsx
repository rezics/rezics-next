import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act, useState } from 'react';
import type { CreateSubjectCommand, CreateResult } from '../src/features/catalogue/create-subject';

test('creation protects exact multilingual/profile drafts, same-path replacement and uncertain recovery', async () => {
  const { Window } = await import(Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir))));
  const window = new Window({ url: 'https://site.test/new' });
  const globals = { window, document: window.document, navigator: window.navigator, IS_REACT_ACT_ENVIRONMENT: true,
    ...Object.fromEntries(['HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLTextAreaElement', 'Element', 'Node', 'MutationObserver', 'ResizeObserver'].map((key) => [key, Reflect.get(window, key)])),
    getComputedStyle: window.getComputedStyle.bind(window), requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window) };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } = await import('@tanstack/react-router');
  const { CreateSubjectForm } = await import('../src/features/catalogue/create-subject-form');
  const { m } = await import('../src/paraglide/messages.js');
  const require = createRequire(createRequire(import.meta.url).resolve('storybook/test'));
  const { default: userEvent } = await import(require.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const host = document.createElement('main'); document.body.append(host);
  const root = createRoot(host);
  const commands: CreateSubjectCommand[] = [];
  let answer: CreateResult = { ok: false, reason: 'unavailable' };
  let deliver: ((result: CreateResult) => void) | undefined;
  let prepared = 0;
  function Creation() {
    const [value, setValue] = useState('');
    return <CreateSubjectForm locale="en" session="signed-in" onNavigate={(href) => void router.navigate({ to: href as never })}
      transport={{ definitions: async () => ({ ok: true, types: [{ id: 'schema:Movie', label: 'Film', description: '' }] }),
        submit: (command) => { commands.push(structuredClone(command)); return new Promise((resolve) => { deliver = resolve; }); },
        read: async () => ({ state: 'ready', href: '/reader' }) }}
      profile={{ title: 'Film', scope: 'test', type: 'schema:Movie', fields: () => <input aria-label="Profile" value={value} onChange={(event) => setValue(event.target.value)} />,
        prepare: (item) => { prepared++; return { item, errors: [] }; } }} />;
  }
  const base = createRootRoute({ component: Outlet });
  const route = createRoute({ getParentRoute: () => base, path: '/new', component: Creation,
    validateSearch: (search) => ({ draft: String(search.draft ?? '') }), remountDeps: ({ search }) => search });
  const router = createRouter({ routeTree: base.addChildren([route, createRoute({ getParentRoute: () => base, path: '/reader', component: () => <p>Reader</p> })]), history: createMemoryHistory({ initialEntries: ['/new'] }) });
  const until = async (ready: () => boolean) => { for (let n = 0; n < 100 && !ready(); n++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); expect(ready()).toBe(true); };
  const control = (id: string) => host.querySelector<HTMLInputElement>(id)!;
  const click = async (text: string) => act(async () => user.click([...document.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === text)!));
  const replace = async (node: HTMLElement, text: string) => act(async () => { await user.clear(node); if (text) await user.type(node, text); });
  const blocked = () => { const event = new window.Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; };
  const dialog = () => document.querySelector('[role="alertdialog"]');
  const attempt = async () => act(async () => { void router.navigate({ to: '/new' as never, search: { draft: 'other' } as never }); });
  try {
    await router.load();
    await act(async () => root.render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>));
    await until(() => !!host.querySelector('form'));
    expect(blocked()).toBe(false);
    await replace(control('[aria-label="Profile"]'), 'Profile value'); expect(blocked()).toBe(true);
    await replace(control('[aria-label="Profile"]'), ''); expect(blocked()).toBe(false);
    expect(prepared).toBe(0);
    await replace(control('#create-label-0'), 'Original title');
    await replace(control('#create-aliases-0'), 'Alias one\nAlias two');
    await click(m.catalogue_create_add_language());
    await replace(control('#create-language-1'), 'ja');
    await replace(control('#create-label-1'), '映画');
    await replace(control('[aria-label="Profile"]'), 'Profile value');
    await attempt(); await until(() => !!dialog());
    await click(m.zone_editor_stay()); await until(() => !dialog());
    expect(control('#create-label-0').value).toBe('Original title');
    expect(control('#create-aliases-0').value).toBe('Alias one\nAlias two');
    expect(control('#create-label-1').value).toBe('映画');
    expect(control('#create-type').value).toBe('schema:Movie');
    expect(control('[aria-label="Profile"]').value).toBe('Profile value');
    await act(async () => host.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    await until(() => commands.length === 1); expect(blocked()).toBe(true);
    await attempt(); await until(() => !!dialog());
    expect(dialog()!.textContent).toContain(m.thread_authoring_leave_pending());
    await click(m.zone_editor_stay()); await until(() => !dialog());
    await act(async () => deliver!(answer));
    await click(m.catalogue_create_retry()); await until(() => commands.length === 2);
    await act(async () => deliver!({ ok: false, reason: 'denied' }));
    expect(control('#create-label-0').disabled).toBe(true);
    await click(m.catalogue_create_retry()); await until(() => commands.length === 3);
    expect(commands[1]).toEqual(commands[0]); expect(commands[2]).toEqual(commands[0]); expect(prepared).toBe(1);
    await act(async () => deliver!({ ok: true, id: 'created', reader: { state: 'ready', href: '/reader' } }));
    await until(() => router.state.location.pathname === '/reader'); expect(dialog()).toBeNull(); expect(blocked()).toBe(false);
    await act(async () => router.navigate({ to: '/new' as never })); await until(() => !!host.querySelector('form'));
    await replace(control('#create-label-0'), 'Discard this');
    await attempt(); await until(() => !!dialog());
    await click(m.thread_authoring_leave()); await until(() => !dialog() && control('#create-label-0')?.value === '');
    expect(blocked()).toBe(false);
  } finally {
    await act(async () => root.unmount()); client.clear(); window.happyDOM.abort(); host.remove();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
