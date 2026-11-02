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
const { DiscoveryKinds } = await import('../src/search/discovery-kinds');
const { setLocale } = await import('../src/paraglide/runtime.js');
const require = createRequire(import.meta.url);
const storybook = createRequire(require.resolve('storybook/test'));
const { default: userEvent } = await import(storybook.resolve('@testing-library/user-event'));
const user = userEvent.setup({ document: window.document });
type Props = ComponentProps<typeof DiscoveryKinds>;
type Loaded = Awaited<ReturnType<Props['load']>>;
const host = document.createElement('main');
document.body.append(host);
let root: ReturnType<typeof createRoot>;

function ready(page: number, next: string | null) {
  return {
    status: 'ready' as const,
    kinds: {
      values: Array.from({ length: 8 }, (_, index) => ({
        id: `schema:${page}-${index}`,
        labels: { en: `Kind ${page}-${index}` },
        icon: 'book',
        count: { kind: `schema:${page}-${index}`, value: 123, exact: true },
      })),
      next,
    },
  };
}

async function show(load: Props['load']) {
  setLocale('en', { reload: false });
  root ??= createRoot(host);
  await act(async () =>
    root.render(
      <form onSubmit={(event) => event.preventDefault()}>
        <button type="button" data-move-focus>
          Other control
        </button>
        <DiscoveryKinds
          key="query"
          initial={ready(0, 'cursor-1').kinds}
          selected={[]}
          locale="en"
          hydrated
          load={load}
        />
      </form>,
    ),
  );
}

function button(label: string) {
  return [...host.querySelectorAll('button')].find((value) => value.textContent === label)!;
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

test('keyboard focus follows More through a surviving page, final page and local restart', async () => {
  let calls = 0;
  let settle!: (value: Loaded) => void;
  await show(async () => {
    if (++calls === 1)
      return new Promise((resolve) => {
        settle = resolve;
      });
    return ready(2, null);
  });
  const source = button('More types');
  await activate(source);
  expect(source.disabled).toBe(true);
  await act(async () => settle(ready(1, 'cursor-2')));
  expect(document.activeElement).toBe(button('More types'));
  await activate(button('More types'));
  expect(document.activeElement).toBe(button('Return to the directory start'));
  await activate(button('Return to the directory start'));
  expect(document.activeElement).toBe(button('More types'));
});

test('a refusal focuses the named recovery region after removing the directory', async () => {
  let settle!: (value: Loaded) => void;
  await show(
    () =>
      new Promise((resolve) => {
        settle = resolve;
      }),
  );
  await activate(button('More types'));
  await act(async () => settle({ status: 'unavailable', recovery: { status: 'denied' } }));
  const region = host.querySelector<HTMLElement>('section[tabindex="-1"]')!;
  expect(host.querySelectorAll('button')).toHaveLength(0);
  expect(region.getAttribute('aria-label')).toBeTruthy();
  expect(document.activeElement).toBe(region);
});

test('a reader who moves focus during a pending read keeps that focus after it resolves', async () => {
  let settle!: (value: Loaded) => void;
  await show(
    () =>
      new Promise((resolve) => {
        settle = resolve;
      }),
  );
  await activate(button('More types'));
  const elsewhere = host.querySelector<HTMLButtonElement>('[data-move-focus]')!;
  elsewhere.focus();
  await act(async () => settle(ready(1, 'cursor-2')));
  expect(document.activeElement).toBe(elsewhere);
});
