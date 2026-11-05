import { afterEach, beforeEach } from 'bun:test';
import { dirname } from 'node:path';
import { act, type ReactNode } from 'react';
import type { Root } from 'react-dom/client';
import type { InventoryPage, OwnedClient } from '../src/security-inventory';
import type { InventorySource } from '../src/security-inventory-view';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', `${import.meta.dir}/../../web`)))
);
let dom = new Window({ url: 'https://auth.test/security' });
const globals = () => ({
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  IS_REACT_ACT_ENVIRONMENT: true,
});
const original = new Map(Object.keys(globals()).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
function install() {
  for (const [key, value] of Object.entries(globals()))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
install();
const { createRoot } = await import('react-dom/client');
export const { m } = await import('../src/paraglide/messages.js');
const { overwriteGetLocale } = await import('../src/paraglide/runtime.js');
export let host: HTMLDivElement;
let root: Root | null = null;
export const tick = (fn: () => void = () => {}) => act(async () => fn());
export function mountedSuite() {
  beforeEach(() => {
    dom = new Window({ url: 'https://auth.test/security' });
    install();
    overwriteGetLocale(() => 'en');
  });
  afterEach(async () => {
    if (root) await tick(() => root!.unmount());
    root = null;
    host?.remove();
    await dom.happyDOM.close();
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
}
export async function render(node: ReactNode) {
  if (!root) {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  }
  await tick(() => root!.render(node));
}
export function button(label: string) {
  const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
export const click = (label: string) => tick(() => button(label).click());
export const expand = (index = 0) =>
  tick(() => host.querySelectorAll<HTMLButtonElement>('[data-owned-control]')[index]!.click());
export const text = () => host.textContent ?? '';
export const row = (id = 'client-A', extra: Partial<OwnedClient> = {}): OwnedClient => ({
  client_id: id,
  display_name: 'Reading companion',
  disabled: false,
  scopes: ['subject:read', 'unfamiliar:future'],
  ...extra,
});
export type Page = InventoryPage<'clients'>;
export const ready = (id = 'client-A', next: string | null = null): Page => ({ kind: 'ready', rows: [row(id)], next });
export function inventory(...pages: (Page | Promise<Page>)[]) {
  const calls: { view: string; cursor: string | undefined; signal: AbortSignal | undefined }[] = [];
  const source: InventorySource = async (view, cursor, signal) => {
    calls.push({ view, cursor, signal });
    const page = pages.shift();
    if (!page) throw new Error('Unexpected inventory read');
    return (await page) as InventoryPage<typeof view>;
  };
  return { source, calls, cursors: () => calls.map((call) => call.cursor) };
}
