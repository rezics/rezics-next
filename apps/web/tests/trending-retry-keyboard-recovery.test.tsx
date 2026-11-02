import { afterAll, afterEach, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act, type ComponentProps } from 'react';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://search.test/en/search' });
const globals = {
  window,
  document: window.document,
  HTMLElement: window.HTMLElement,
  Node: window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const { createRoot } = await import('react-dom/client');
const { TrendingSearchesSection } = await import('../src/search/trending-section');
const { m } = await import('../src/paraglide/messages.js');
const require = createRequire(import.meta.url);
const storybook = createRequire(require.resolve('storybook/test'));
const { default: userEvent } = await import(storybook.resolve('@testing-library/user-event'));
const user = userEvent.setup({ document: window.document });
const host = document.createElement('main');
document.body.append(host);
let root: ReturnType<typeof createRoot>;
const page = (count: number) => ({
  next: null,
  trendingSearches: Array.from({ length: count }, (_, i) => ({ query: `query-${i}`, display: `Term ${i}` })),
});
type Props = ComponentProps<typeof TrendingSearchesSection>;

async function show(state: Props['state'], extra?: Pick<Props, 'onRetry' | 'isCurrent'>) {
  root ??= createRoot(host);
  await act(async () =>
    root.render(
      <form onSubmit={(event) => event.preventDefault()}>
        <button type="button" data-move-focus>
          Other control
        </button>
        <TrendingSearchesSection state={state} onRetry={extra?.onRetry ?? (() => {})} isCurrent={extra?.isCurrent} />
      </form>,
    ),
  );
}

function retry() {
  return [...host.querySelectorAll('button')].find((button) => button.textContent === m.search_facet_retry())!;
}

async function activate(value: HTMLButtonElement) {
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

test('keyboard Retry keeps a surviving target after ready results replace it', async () => {
  await show({ status: 'loading' });
  await show({ status: 'ready', page: page(1) });
  const region = () => host.querySelector<HTMLElement>('[data-trending-searches]')!;
  const term = () => host.querySelector('li button');
  expect(document.activeElement).not.toBe(term());
  expect(document.activeElement).not.toBe(region());

  await show({ status: 'unavailable' });
  await activate(retry());
  await show({ status: 'loading' });
  expect(retry().disabled).toBe(true);
  expect(document.activeElement).toBe(retry());
  await show({ status: 'ready', page: page(2) });
  expect(document.activeElement).toBe(term());

  await show({ status: 'preparing' });
  await activate(retry());
  await show({ status: 'loading' });
  await show({ status: 'ready', page: page(0) });
  expect(region().getAttribute('aria-label')).toBe(m.header_search_trending_searches());
  expect(document.activeElement).toBe(region());

  await show({ status: 'unavailable' });
  await activate(retry());
  await show({ status: 'loading' });
  await show({ status: 'unavailable' });
  expect(document.activeElement).toBe(retry());

  await activate(retry());
  await show({ status: 'loading' });
  const elsewhere = host.querySelector<HTMLButtonElement>('[data-move-focus]')!;
  elsewhere.focus();
  await show({ status: 'ready', page: page(1) });
  expect(document.activeElement).toBe(elsewhere);
});

test('retired and unmounted manual retries do not move focus', async () => {
  let live = true;
  await show({ status: 'unavailable' }, { isCurrent: () => live });
  await activate(retry());
  await show({ status: 'loading' }, { isCurrent: () => live });
  live = false;
  await show({ status: 'ready', page: page(1) }, { isCurrent: () => live });
  expect(document.activeElement).not.toBe(host.querySelector('li button'));
  expect(document.activeElement).not.toBe(host.querySelector('[data-trending-searches]'));

  live = true;
  await show({ status: 'unavailable' }, { isCurrent: () => live });
  await activate(retry());
  await act(async () => root.unmount());
  root = undefined!;
  expect(host.querySelector('[data-trending-searches]')).toBeNull();
});
