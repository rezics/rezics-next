import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { RealmClaimReviewView } from '../src/community/realm-claim-review-page';
import type { RealmClaimReviewAdapter, RealmClaimReviewRead } from '../src/community/realm-claim-review';
import { m } from '../src/paraglide/messages.js';

const { Window } = await import(Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir))));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

test('queue focus follows only a current keyboard activation', async () => {
  const window = new Window({ url: 'https://site.test/en/realms/example/claims' });
  const globals = {
    window, document: window.document, navigator: window.navigator, location: window.location,
    HTMLElement: window.HTMLElement, HTMLButtonElement: window.HTMLButtonElement, HTMLFormElement: window.HTMLFormElement,
    Element: window.Element, Node: window.Node, Document: window.Document, DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver, ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window), requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window), matchMedia: window.matchMedia.bind(window), IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.entries(globals).forEach(([key, value]) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }));
  const { createRoot } = await import('react-dom/client');
  const host = window.document.createElement('main');
  const sentinel = window.document.createElement('button');
  window.document.body.append(host, sentinel);
  const root = createRoot(host);
  const ready: RealmClaimReviewRead = { kind: 'ready', page: { claimRequests: [], next: null } };
  const nextPage: RealmClaimReviewRead = { kind: 'ready', page: { claimRequests: [], next: 'opaque-next' } };
  const realmId = '00000000-0000-4000-8000-000000000001';
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const adapter = (read: Promise<RealmClaimReviewRead>): RealmClaimReviewAdapter => ({ read: async () => read, approve: async () => ({ kind: 'unavailable' }) });
  async function render(read: Promise<RealmClaimReviewRead>, initial = ready, connectionRevision = 0) {
    await act(async () => { root.render(<RealmClaimReviewView realmId={realmId} initial={initial} adapter={adapter(read)} connectionRevision={connectionRevision} />); await tick(); });
  }
  const button = (label: string) => [...host.querySelectorAll('button')].find((node) => node.textContent?.trim() === label)!;
  const queue = () => host.querySelector('h2[id$="-queue"]')!;
  async function keyboardClick(node: HTMLButtonElement) { node.focus(); await act(async () => { node.click(); await tick(); }); }
  async function finish(request: ReturnType<typeof deferred<RealmClaimReviewRead>>, result = ready) { await act(async () => { request.resolve(result); await tick(); }); }
  try {
    sentinel.focus();
    await render(Promise.resolve(ready));
    expect(window.document.activeElement).toBe(sentinel);

    const current = deferred<RealmClaimReviewRead>();
    await render(current.promise);
    await keyboardClick(button(m.realm_review_refresh()));
    await finish(current);
    expect(window.document.activeElement).toBe(queue());

    const moved = deferred<RealmClaimReviewRead>();
    await render(moved.promise);
    await keyboardClick(button(m.realm_review_refresh()));
    sentinel.focus();
    await finish(moved);
    expect(window.document.activeElement).toBe(sentinel);

    const pointer = deferred<RealmClaimReviewRead>();
    await render(pointer.promise);
    await keyboardClick(button(m.realm_review_refresh()));
    host.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
    await finish(pointer);
    expect(window.document.activeElement).not.toBe(queue());

    const replaced = deferred<RealmClaimReviewRead>();
    await render(replaced.promise);
    const refresh = button(m.realm_review_refresh());
    await keyboardClick(refresh);
    await render(Promise.resolve(ready));
    await finish(replaced);
    expect(window.document.activeElement).toBe(button(m.realm_review_refresh()));

    const passive = deferred<RealmClaimReviewRead>();
    await render(passive.promise, ready, 1);
    sentinel.focus();
    await finish(passive);
    expect(window.document.activeElement).toBe(sentinel);

    const pointerNavigation = deferred<RealmClaimReviewRead>();
    await render(pointerNavigation.promise, nextPage);
    const next = button(m.realm_review_next());
    next.focus();
    await act(async () => { next.dispatchEvent(new window.Event('pointerdown', { bubbles: true })); next.dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 1 })); await tick(); });
    await finish(pointerNavigation, nextPage);
    expect(window.document.activeElement).not.toBe(queue());
  } finally {
    await act(async () => root.unmount());
    window.happyDOM.abort();
    for (const [key, descriptor] of previous) descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
  }
});
