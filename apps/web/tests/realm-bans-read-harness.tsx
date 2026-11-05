import { afterAll, afterEach } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import type { BanReadState } from '../src/community/realm-bans';
import type { RealmBansControlProps } from '../src/community/realm-bans-control';

export async function banReadHarness() {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/realms/one' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    location: window.location,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    HTMLFormElement: window.HTMLFormElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    matchMedia: window.matchMedia.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  const { createRoot } = await import('react-dom/client');
  const { RealmBansControl } = await import('../src/community/realm-bans-control');
  const { m } = await import('../src/paraglide/messages.js');
  const host = document.createElement('main');
  const outside = document.createElement('button');
  document.body.append(host, outside);
  let root: ReturnType<typeof createRoot> | undefined;
  const ready = (next: string | null): BanReadState => ({ state: 'ready', page: { items: [], next } });
  const write: RealmBansControlProps['write'] = async () => ({ ok: false, reason: 'unavailable' });
  function props(realmId: string, initial: BanReadState | undefined, read: RealmBansControlProps['read']) {
    return { realmId, initial, ready: true, read, write };
  }
  async function paint(next: RealmBansControlProps) {
    await act(async () => {
      root ??= createRoot(host);
      root.render(<RealmBansControl {...next} />);
      await Promise.resolve();
    });
  }
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => (resolve = done));
    return { promise, resolve };
  }
  function button(label: string) {
    return [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (item) => item.textContent?.trim() === label,
    )!;
  }
  async function activate(label: string, detail = 0) {
    await act(async () => {
      const target = button(label);
      target.focus();
      if (detail) target.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
      target.dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail }));
      await Promise.resolve();
    });
  }
  async function settle(read: ReturnType<typeof deferred<BanReadState>>, state: BanReadState) {
    await act(async () => {
      read.resolve(state);
      await read.promise;
    });
  }
  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = undefined;
    host.replaceChildren();
  });
  afterAll(() => {
    host.remove();
    outside.remove();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    window.close();
  });
  return { window, host, outside, ready, write, props, paint, deferred, button, activate, settle, m };
}
