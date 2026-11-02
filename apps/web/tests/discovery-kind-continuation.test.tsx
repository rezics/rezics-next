import { afterAll, afterEach, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, useState, type ComponentProps } from 'react';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://search.test/en/search' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  Element: window.Element,
  Node: window.Node,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const { createRoot } = await import('react-dom/client');
const { DiscoveryKinds } = await import('../src/search/discovery-kinds');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');
type Props = ComponentProps<typeof DiscoveryKinds>;
type Loaded = Awaited<ReturnType<Props['load']>>;
const host = document.createElement('main');
document.body.append(host);
let update!: (value: { identity: string; props: Props }) => void;
let root: ReturnType<typeof createRoot>;

function kind(id: string) {
  return { id, labels: { en: id }, icon: 'book' };
}

function ready(ids: string[], next: string | null) {
  return { status: 'ready' as const, kinds: { values: ids.map(kind), next } };
}

function props(initial: Props['initial'], selected: string[], load: Props['load']): Props {
  return { initial, selected, locale: 'en', hydrated: true, load };
}

function View() {
  const [current, setCurrent] = useState<{ identity: string; props: Props }>();
  update = setCurrent;
  return current ? <DiscoveryKinds key={current.identity} {...current.props} /> : null;
}

function more() {
  return host.querySelector('button') as HTMLButtonElement;
}

async function clickMore() {
  await act(async () => more().click());
}

function hiddenKinds() {
  return [...host.querySelectorAll<HTMLInputElement>('input[type="hidden"][name="kinds"]')].map(({ value }) => value);
}

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host.replaceChildren();
});

afterAll(() => {
  setLocale('en', { reload: false });
  window.happyDOM.abort();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('result-kind cycles keep accepted choices and failures retry the current cursor', async () => {
  setLocale('en', { reload: false });
  const oldCalls: string[] = [];
  let obsoleteSignal: AbortSignal | undefined;
  let resolveObsolete!: (result: Loaded) => void;
  const obsolete = new Promise<Loaded>((resolve) => (resolveObsolete = resolve));
  const oldLoad: Props['load'] = async (cursor, signal) => {
    oldCalls.push(cursor);
    if (oldCalls.length === 1) return ready(['schema:Hidden'], 'cursor-a');
    if (oldCalls.length === 2) return ready(['catalogue:Writer'], 'cursor-b');
    if (oldCalls.length === 3) return ready(['schema:Hidden'], 'cursor-a');
    obsoleteSignal = signal;
    return obsolete;
  };
  root = createRoot(host);
  await act(async () => root.render(<View />));
  await act(async () =>
    update({
      identity: 'query-one/checkpoint-one',
      props: props(
        { values: [kind('catalogue:Atlas')], next: 'cursor-a' },
        ['catalogue:Atlas', 'schema:Hidden'],
        oldLoad,
      ),
    }),
  );

  await clickMore();
  expect(host.textContent).not.toContain('schema:Hidden');
  expect(host.textContent).toContain('catalogue:Atlas');
  expect(hiddenKinds()).toEqual(['schema:Hidden']);
  expect((host.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(true);
  expect(host.querySelector('[role="alert"]')).toBeTruthy();
  await clickMore();
  await clickMore();
  expect(host.textContent).toContain('catalogue:Writer');
  expect(host.textContent).not.toContain('schema:Hidden');
  expect(hiddenKinds()).toEqual(['schema:Hidden']);
  await clickMore();

  const freshCalls: string[] = [];
  const freshLoad: Props['load'] = async (cursor) => {
    freshCalls.push(cursor);
    return freshCalls.length === 1 ? { status: 'unavailable' } : ready(['catalogue:Fresh'], 'cursor-a');
  };
  await act(async () =>
    update({
      identity: 'query-two/checkpoint-two',
      props: props({ values: [kind('catalogue:New')], next: 'cursor-b' }, ['schema:Hidden'], freshLoad),
    }),
  );
  expect(obsoleteSignal?.aborted).toBe(true);
  await act(async () => {
    resolveObsolete(ready(['catalogue:Stale'], 'cursor-stale'));
    await obsolete;
  });
  expect(host.textContent).not.toContain('catalogue:Stale');
  await clickMore();
  expect(host.querySelector('[role="alert"]')).toBeTruthy();
  expect(hiddenKinds()).toEqual(['schema:Hidden']);
  await clickMore();
  expect(oldCalls).toEqual(['cursor-a', 'cursor-a', 'cursor-b', 'cursor-b']);
  expect(freshCalls).toEqual(['cursor-b', 'cursor-b']);
  expect(host.textContent).toContain('catalogue:Fresh');
  expect(host.textContent).not.toContain('catalogue:Stale');
});
