import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import type { SetupResult, SetupSnapshot } from '../src/community/space-setup';
import type { SetupTransport } from '../src/stories/patterns/space-setup/space-setup';

const { Window } = await import(Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir))));
const window = new Window({ url: 'https://site.test/en/realms/new' });
const globals = { window, document: window.document, navigator: window.navigator, location: window.location,
  HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement, HTMLButtonElement: window.HTMLButtonElement,
  HTMLFormElement: window.HTMLFormElement, Element: window.Element, Node: window.Node, Document: window.Document,
  DocumentFragment: window.DocumentFragment, MutationObserver: window.MutationObserver, ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window), requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window), matchMedia: window.matchMedia.bind(window), IS_REACT_ACT_ENVIRONMENT: true };
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const start = await import('../.storybook/react-start');
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const { createRoot } = await import('react-dom/client');
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
const { SpaceSetupForm } = await import('../src/stories/patterns/space-setup/space-setup');
const { SpaceSetupCallerLifetimeContext, standaloneSpaceSetupLifetime } = await import('../src/community/space-setup-lifetime');
const { m } = await import('../src/paraglide/messages.js');
const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const initial: SetupSnapshot = { kind: 'ready', space: { id: id(1), head: id(2), title: 'Space', summary: '', address: 'old-space', realmId: id(3) }, realm: null, permitted: { address: true, settings: false, scheme: false, board: false } };
const saved: SetupSnapshot = { ...initial, space: { ...initial.space!, address: 'new-space' } };
const updated: SetupResult = { kind: 'space', space: saved.space! };
const host = window.document.createElement('main');
window.document.body.append(host);
let root: ReturnType<typeof createRoot> | undefined;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => (resolve = done)); return { promise, resolve }; }
async function tick() { await act(async () => new Promise((resolve) => setTimeout(resolve, 0))); }
async function unmount() { if (root) await act(async () => root!.unmount()); root = undefined; host.replaceChildren(); }
async function mount(transport: SetupTransport, caller = standaloneSpaceSetupLifetime()) {
  await unmount();
  const route = createRootRoute({ component: () => <SpaceSetupCallerLifetimeContext.Provider value={caller}><SpaceSetupForm initial={initial} transport={transport} /></SpaceSetupCallerLifetimeContext.Provider> });
  const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/realms/new'] }) });
  await router.load(); root = createRoot(host); await act(async () => root!.render(<RouterProvider router={router} />)); await tick(); return caller;
}
function transport(read: SetupTransport['read']): SetupTransport { return { command: async () => updated, read, choice: async () => ({ kind: 'failure', reason: 'unavailable', status: 503 }) }; }
async function keyboardSubmit() {
  const input = host.querySelector('form input')!;
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'new-space');
  input.dispatchEvent(new window.Event('input', { bubbles: true })); input.focus();
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  host.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await tick();
}
function stepButton(index: number) { return host.querySelectorAll<HTMLButtonElement>('nav button')[index]!; }

test('keyboard handoffs focus committed headings; pointer navigation keeps focus local', async () => {
  await mount(transport(async () => saved)); const realm = stepButton(1);
  expect(window.document.activeElement).not.toBe(host.querySelector('h2'));
  realm.focus(); realm.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  realm.dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 0 })); await tick();
  expect(host.querySelector('h2')?.textContent).toBe(m.space_setup_realm()); expect(window.document.activeElement).toBe(host.querySelector('h2'));
  stepButton(0).dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true })); stepButton(0).focus();
  stepButton(0).dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 1 })); await tick();
  expect(host.querySelector('h2')?.textContent).toBe(m.space_setup_identity()); expect(window.document.activeElement).not.toBe(host.querySelector('h2'));
});

test('read completion advances without stealing focus after focus, pointer, or caller changes', async () => {
  for (const retired of ['focus', 'pointer', 'caller'] as const) {
    const read = deferred<SetupSnapshot>(); let reading = false;
    const caller = await mount(transport(() => { reading = true; return read.promise; })); await keyboardSubmit(); expect(reading).toBe(true);
    const outside = window.document.createElement('button'); window.document.body.append(outside);
    if (retired === 'focus') outside.focus();
    if (retired === 'pointer') outside.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true }));
    if (retired === 'caller') caller.retire();
    read.resolve(saved); await tick();
    if (retired === 'caller') expect(host.querySelector('h2')).toBeNull();
    else { expect(host.querySelector('h2')?.textContent).toBe(m.space_setup_realm()); expect(window.document.activeElement).not.toBe(host.querySelector('h2')); }
    outside.remove();
  }
});

test('keyboard command success focuses the heading after refreshed content commits', async () => {
  await mount(transport(async () => saved)); await keyboardSubmit();
  expect(host.querySelector('h2')?.textContent).toBe(m.space_setup_realm()); expect(window.document.activeElement).toBe(host.querySelector('h2'));
});

afterAll(async () => {
  await unmount(); mock.restore(); host.remove(); window.happyDOM.abort();
  for (const [key, descriptor] of previous) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
});
