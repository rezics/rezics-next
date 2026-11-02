import { afterAll, afterEach, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import type { BanReadState } from '../src/community/realm-bans';
import type { RealmBansControlProps } from '../src/community/realm-bans-control';

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
    root!.render(<RealmBansControl {...next} />);
    await Promise.resolve();
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}
function button(label: string) {
  return [...host.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === label)!;
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

test('keyboard continuation focuses its result only after the deferred read', async () => {
  const read = deferred<BanReadState>();
  const cursors: (string | undefined)[] = [];
  root = createRoot(host);
  await paint(props('one', ready('page-two'), (cursor) => (cursors.push(cursor), read.promise)));
  await activate(m.realm_bans_next());
  expect(cursors).toEqual(['page-two']);
  expect(document.activeElement).not.toBe(host.querySelector('h2'));
  await settle(read, ready(null));
  expect(document.activeElement).toBe(host.querySelector('h2'));
});

test('pointer activation, later pointer, focus movement, and Tab cancel the handoff', async () => {
  const reads = Array.from({ length: 3 }, () => deferred<BanReadState>());
  let index = 0;
  root = createRoot(host);
  await paint(props('one', ready('page-two'), () => reads[index++]!.promise));
  await activate(m.realm_bans_next(), 1);
  await settle(reads[0]!, ready('page-three'));
  expect(document.activeElement).not.toBe(host.querySelector('h2'));
  await activate(m.realm_bans_next());
  document.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
  outside.focus();
  await settle(reads[1]!, ready('page-four'));
  expect(document.activeElement).toBe(outside);
  await activate(m.realm_bans_next());
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  outside.focus();
  await settle(reads[2]!, ready(null));
  expect(document.activeElement).toBe(outside);
});

test('a failed continuation focuses retry and preserves its exact cursor', async () => {
  const failed = deferred<BanReadState>();
  const retried = deferred<BanReadState>();
  const cursors: (string | undefined)[] = [];
  root = createRoot(host);
  await paint(
    props('one', ready('page-two'), (cursor) => {
      cursors.push(cursor);
      return cursors.length === 1 ? failed.promise : retried.promise;
    }),
  );
  await activate(m.realm_bans_next());
  await settle(failed, { state: 'unavailable' });
  expect(document.activeElement).toBe(button(m.realm_bans_read_retry()));
  await activate(m.realm_bans_read_retry());
  expect(cursors).toEqual(['page-two', 'page-two']);
  await settle(retried, ready(null));
  expect(document.activeElement).toBe(host.querySelector('h2'));
});

test('an ABA caller replacement retires a deferred read focus intent', async () => {
  const oldRead = deferred<BanReadState>();
  const initial = ready('page-two');
  let reads = 0;
  const readA = () => (++reads === 1 ? oldRead.promise : Promise.resolve(ready(null)));
  const propsA = props('one', initial, readA);
  root = createRoot(host);
  await paint(propsA);
  await activate(m.realm_bans_next());
  await paint(props('two', ready(null), async () => ready(null)));
  await paint(propsA);
  await settle(oldRead, ready(null));
  expect(reads).toBe(2);
  expect(document.activeElement).not.toBe(host.querySelector('h2'));
});
