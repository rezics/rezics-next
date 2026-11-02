import { afterAll, afterEach, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import type { RecentEntry, RecentHistory, RecentHistoryOwner } from '../src/search/recent-history';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://search.test/en/search' });
const globals = {
  window,
  document: window.document,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  Node: window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const { createRoot } = await import('react-dom/client');
const { RecentHistoryView } = await import('../src/search/recent');
const { RecentPanel } = await import('../src/search/recent-panel');
const { m } = await import('../src/paraglide/messages.js');
const require = createRequire(import.meta.url);
const storybook = createRequire(require.resolve('storybook/test'));
const { default: userEvent } = await import(storybook.resolve('@testing-library/user-event'));
const user = userEvent.setup({ document: window.document });
const host = document.createElement('main');
document.body.append(host);
let root: ReturnType<typeof createRoot>;
const row = (query: string): RecentEntry => ({ id: JSON.stringify([null, null, query]), query, visitedAt: 1 });
type Surface = 'history' | 'header';

function history(extra: Partial<RecentHistory> = {}): RecentHistory {
  return {
    entries: extra.entries ?? [row('Kokoro')],
    persistence: 'local',
    sync: extra.sync ?? 'local-only',
    remember() {},
    remove() {},
    retry: extra.retry ?? (() => {}),
    ...extra,
  };
}

async function show(surface: Surface, state: RecentHistory) {
  root ??= createRoot(host);
  await act(async () =>
    root.render(
      createElement(
        'form',
        { onSubmit: (event: { preventDefault(): void }) => event.preventDefault() },
        createElement('button', { type: 'button', 'data-move-focus': '' }, 'Other control'),
        surface === 'history'
          ? createElement(RecentHistoryView, { ...state, history: true })
          : createElement(RecentPanel, { history: state, global: false }),
      ),
    ),
  );
}

const reload = () =>
  [...host.querySelectorAll('button')].find((button) => button.textContent === m.search_history_reload());
const region = (surface: Surface) =>
  [...host.querySelectorAll('section')].find(
    (section) =>
      section.getAttribute('aria-label') === (surface === 'history' ? m.search_history() : m.header_search_recent()),
  );

async function activate() {
  const value = reload()!;
  value.focus();
  expect(document.activeElement).toBe(value);
  await act(async () => user.keyboard('{Enter}'));
}

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  root = undefined!;
  host.replaceChildren();
});
afterAll(() => {
  window.happyDOM.abort();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('history and Header reload recover only onto a surviving current action or the named region', async () => {
  for (const surface of ['history', 'header'] as const) {
    await show(surface, history({ failure: 'unavailable' }));
    expect(host.textContent).toContain('Kokoro');
    await activate();
    await show(surface, history({ sync: 'pending' }));
    expect(reload()).toBeUndefined();
    expect(host.textContent).toContain('Kokoro');
    expect(host.textContent).toContain(
      surface === 'history' ? m.header_search_loading() : m.header_search_history_pending(),
    );
    await show(surface, history());
    expect(document.activeElement).toBe(region(surface));

    await show(surface, history({ failure: 'unavailable' }));
    await activate();
    await show(surface, history({ sync: 'pending', entries: [] }));
    await show(surface, history({ sync: 'synced', entries: [] }));
    expect(document.activeElement).toBe(region(surface));

    await show(surface, history({ failure: 'unavailable' }));
    await activate();
    await show(surface, history({ sync: 'pending' }));
    await show(surface, history({ failure: 'unavailable' }));
    expect(document.activeElement).toBe(reload());

    await activate();
    await show(surface, history({ sync: 'pending' }));
    const elsewhere = host.querySelector<HTMLButtonElement>('[data-move-focus]')!;
    elsewhere.focus();
    await show(surface, history());
    expect(document.activeElement).toBe(elsewhere);
    await act(async () => root.unmount());
    root = undefined!;
    host.replaceChildren();
  }
});

test('replaced owners, stale currentness and Header unmount drop a pending reload recovery', async () => {
  const stale: RecentHistoryOwner = () => true;
  let live = true;
  const current: RecentHistoryOwner = () => live;
  await show('history', history({ failure: 'unavailable', owner: stale }));
  await activate();
  await show('history', history({ sync: 'pending', owner: stale }));
  await show('history', history({ owner: () => true }));
  expect(document.activeElement).not.toBe(region('history'));

  await show('header', history({ failure: 'unavailable', owner: current }));
  await activate();
  await show('header', history({ sync: 'pending', owner: current }));
  live = false;
  await show('header', history({ owner: current }));
  expect(document.activeElement).not.toBe(region('header'));

  live = true;
  await show('header', history({ failure: 'unavailable', owner: current }));
  await activate();
  await act(async () => root.unmount());
  root = undefined!;
  expect(region('header')).toBeUndefined();
});
