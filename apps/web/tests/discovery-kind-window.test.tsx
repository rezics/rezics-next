import { afterAll, afterEach, expect, test } from 'bun:test';
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
type Props = ComponentProps<typeof DiscoveryKinds>;
type Loaded = Awaited<ReturnType<Props['load']>>;
const host = document.createElement('main');
document.body.append(host);
let root: ReturnType<typeof createRoot>;

function kind(id: string) {
  return { id, labels: { en: id }, icon: 'book', count: { kind: id, value: 123, exact: true } };
}

function ready(ids: string[], next: string | null) {
  return { status: 'ready' as const, kinds: { values: ids.map(kind), next } };
}

function props(initial: Props['initial'], selected: string[], load: Props['load']): Props {
  return { initial, selected, locale: 'en', hydrated: true, load };
}

async function show(identity: string, value: Props) {
  setLocale('en', { reload: false });
  if (!root) root = createRoot(host);
  await act(async () =>
    root.render(
      <form onSubmit={(event) => event.preventDefault()}>
        <DiscoveryKinds key={identity} {...value} />
      </form>,
    ),
  );
}

function more() {
  return [...host.querySelectorAll('button')].find((button) => button.textContent === 'More types')!;
}

async function click(label = 'More types') {
  await act(async () => [...host.querySelectorAll('button')].find((button) => button.textContent === label)!.click());
}

function hiddenKinds() {
  return [...host.querySelectorAll<HTMLInputElement>('input[type="hidden"][name="kinds"]')].map(({ value }) => value);
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

function submitted() {
  return new window.FormData(host.querySelector('form')!).getAll('kinds').map(String).sort();
}

const ids = (page: number) => Array.from({ length: 8 }, (_, index) => `schema:${page}-${index}`);
const visible = () =>
  [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].map((input) => input.value);

test('32 explicit reads replace one eight-option window, preserve exact selections and initial counts', async () => {
  const calls: string[] = [];
  const selected = ['schema:0-0', 'schema:1-0', 'schema:2-1', 'external', 'external'];
  await show(
    'query',
    props(ready(ids(0), 'cursor-1').kinds, selected, async (cursor) => {
      calls.push(cursor);
      return ready(ids(calls.length), `cursor-${calls.length + 1}`);
    }),
  );
  expect(calls).toEqual([]);
  for (let page = 1; page <= 32; page++) {
    await click();
    expect(visible()).toEqual([...ids(0), ...ids(page)]);
    expect(submitted()).toEqual([...new Set(selected)].sort());
    expect(host.textContent!.match(/123/g)).toHaveLength(8);
  }
  expect(calls).toEqual(Array.from({ length: 32 }, (_, index) => `cursor-${index + 1}`));
  expect(more()).toBeUndefined();
  expect(host.textContent).toContain('browsing limit');
  await click('Return to the directory start');
  expect(visible()).toEqual(ids(0));
  expect(hiddenKinds().sort()).toEqual(['external', 'schema:1-0', 'schema:2-1']);
  expect(more()).toBeUndefined();
  expect(calls).toHaveLength(32);
});

test('pending reads and transport retries retain the window, cursor and native checkbox changes', async () => {
  let settle!: (value: Loaded) => void;
  const calls: string[] = [];
  await show(
    'query',
    props(ready(ids(0), 'opaque+/=').kinds, [], async (cursor) => {
      calls.push(cursor);
      if (calls.length === 1) return ready(ids(1), 'exact-next');
      if (calls.length === 2)
        return new Promise((resolve) => {
          settle = resolve;
        });
      if (calls.length === 3) throw new Error('transport');
      return ready(ids(2), null);
    }),
  );
  expect(submitted()).toEqual([]);
  expect(host.textContent).toContain('All result types');
  await click();
  const chosen = host.querySelector<HTMLInputElement>('input[value="schema:1-0"]')!;
  await act(async () => chosen.click());
  await click();
  expect(more().disabled).toBe(true);
  expect(visible()).toEqual([...ids(0), ...ids(1)]);
  expect(submitted()).toEqual(['schema:1-0']);
  await act(async () => settle({ status: 'unavailable', recovery: { status: 'unavailable' } }));
  await click();
  expect(visible()).toEqual([...ids(0), ...ids(1)]);
  await click();
  expect(calls).toEqual(['opaque+/=', 'exact-next', 'exact-next', 'exact-next']);
  expect(hiddenKinds()).toEqual(['schema:1-0']);
  await click('Return to the directory start');
  expect(visible()).toEqual(ids(0));
  expect(submitted()).toEqual(['schema:1-0']);
});

test('cycles and duplicate or empty progress stop explicit paging and permit return to the accepted start', async () => {
  const invalid = [ready(ids(3), 'a'), ready(ids(1), 'd'), ready(['duplicate', 'duplicate'], 'd'), ready([], 'd')];
  for (const [index, failure] of invalid.entries()) {
    let calls = 0;
    await show(
      String(index),
      props(ready(ids(0), 'a').kinds, ['schema:1-0'], async () => {
        calls++;
        return calls === 1 ? ready(ids(1), 'b') : calls === 2 ? ready(ids(2), 'c') : failure;
      }),
    );
    await click();
    await click();
    await click();
    expect(visible()).toEqual([...ids(0), ...ids(2)]);
    expect(more()).toBeUndefined();
    expect(host.textContent).toContain('did not advance');
    await click('Return to the directory start');
    expect(visible()).toEqual(ids(0));
    expect(submitted()).toEqual(['schema:1-0']);
    expect(more()).toBeDefined();
  }
});

test('native refusals hide accepted options and a changed query aborts obsolete reads', async () => {
  for (const status of ['denied', 'closed', 'restart', 'session', 'source-not-ready'] as const) {
    await show(
      status,
      props(ready(ids(0), 'a').kinds, ['schema:0-0'], async () => ({ status: 'unavailable', recovery: { status } })),
    );
    await click();
    expect(visible()).toEqual([]);
    expect(host.querySelector('button')).toBeNull();
    expect(submitted()).toEqual(['schema:0-0']);
  }
  let signal!: AbortSignal;
  let settle!: (value: Loaded) => void;
  await show(
    'old-query/en/checkpoint',
    props(ready(ids(0), 'a').kinds, [], async (_cursor, pending) => {
      signal = pending;
      return new Promise((resolve) => {
        settle = resolve;
      });
    }),
  );
  await click();
  await show(
    'new-query/ja/new-checkpoint',
    props(ready(ids(9), 'fresh').kinds, [], async () => ready(ids(10), null)),
  );
  expect(signal.aborted).toBe(true);
  await act(async () => settle(ready(ids(1), null)));
  expect(visible()).toEqual(ids(9));
  await click();
  expect(visible()).toEqual([...ids(9), ...ids(10)]);
});
