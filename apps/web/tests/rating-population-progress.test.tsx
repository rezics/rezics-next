import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import * as start from '../.storybook/react-start';
import type { PopulationEnvelope, PopulationInput } from '../src/features/pages/subject-rating-populations';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/subjects/work' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  Element: window.Element,
  Node: window.Node,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  HTMLInputElement: window.HTMLInputElement,
  HTMLButtonElement: window.HTMLButtonElement,
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
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { SubjectRatingPopulations } = await import('../src/features/pages/subject-rating-populations-view');
const { m } = await import('../src/paraglide/messages.js');
const host = window.document.createElement('main') as unknown as HTMLElement;
window.document.body.append(host);
const session = { state: 'signed-in' as const, subject: 'reader', csrfToken: null };
const question = {
  id: 'question',
  revision: 1,
  grain: 'work' as const,
  label: 'Rating',
  scale: { min: 0, max: 20, displayStep: 1 },
};
const item = (id: string) => ({ id, name: `Realm ${id}`, figure: { kind: 'failed' as const } });
const ready = (ids: string[], next: string | null = null): PopulationEnvelope['result'] => ({
  kind: 'ready',
  value: { items: ids.map(item), next, incomplete: false },
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
let root: ReturnType<typeof createRoot>;
let cache: InstanceType<typeof QueryClient>;
let calls: PopulationInput[];
let denied: Set<string>;
let directory: (input: PopulationInput) => PopulationEnvelope['result'] | Promise<PopulationEnvelope['result']>;
const read = async (input: PopulationInput): Promise<PopulationEnvelope> => {
  calls.push(input);
  const result = input.selected ? ready(input.selected.filter((id) => !denied.has(id))) : await directory(input);
  if (input.selected && result.kind === 'ready')
    result.value.incomplete = result.value.items.length !== input.selected.length;
  return { subject: input.id, question: input.question, reader: input.expectedReader, result };
};
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
async function settle(predicate: () => boolean) {
  for (let i = 0; i < 40 && !predicate(); i++) await act(tick);
  expect(predicate()).toBe(true);
}
async function paint() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={cache}>
        <SubjectRatingPopulations subjectId="work" question={question} locale="en" session={session} read={read} />
      </QueryClientProvider>,
    );
    await tick();
  });
}
const boxes = () => [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
const button = (text: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === text)!;
const next = () => button(m.rating_population_next());
const restart = () => button(m.rating_population_restart());
const retryDirectory = () => host.querySelector<HTMLButtonElement>('[data-source="directory"] button')!;
const directories = () => calls.filter((input) => !input.selected);
const comparisons = () => [...host.querySelectorAll('[data-slot="rating-comparison"]')].map((node) => node.textContent);
async function click(node: HTMLElement) {
  await act(async () => {
    node.click();
    await tick();
  });
}
beforeEach(() => {
  calls = [];
  denied = new Set();
  directory = () => ready(['first', 'second'], 'opaque +/=');
  cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  cache.setQueryData(['session'], session);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  cache.clear();
});
afterAll(async () => {
  mock.restore();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await window.happyDOM.close();
});

test('a pending or failed next keeps one accepted window, retries the exact cursor, and preserves ordered comparisons and their own retry', async () => {
  await paint();
  await settle(() => boxes().length === 2);
  await click(boxes()[1]!);
  await click(boxes()[0]!);
  await settle(() => comparisons().length === 2);
  const ordered = comparisons();
  const held = deferred<PopulationEnvelope['result']>();
  directory = () => held.promise;
  await click(next());
  expect(boxes()).toHaveLength(2);
  expect(next().disabled).toBe(true);
  held.resolve({ kind: 'failed' });
  await settle(() => !!retryDirectory());
  expect(boxes().every((box) => box.checked)).toBe(true);
  expect(comparisons()).toEqual(ordered);
  directory = () => ready(['third'], null);
  await click(retryDirectory());
  await settle(() => boxes().length === 1);
  expect(directories().map((input) => input.cursor)).toEqual([undefined, 'opaque +/=', 'opaque +/=']);
  expect(comparisons()).toEqual(ordered);
  expect(next().disabled).toBe(true);
  await click(button(m.subject_section_retry()));
  expect(calls.at(-1)?.selected).toEqual(['second', 'first']);
  expect(directories()).toHaveLength(3);
  directory = () => ready(['first'], 'new');
  await click(restart());
  await settle(() => boxes()[0]?.checked === true);
  expect(comparisons()).toEqual(ordered);
  expect(directories().at(-1)?.cursor).toBeUndefined();
});

test('empty pages require explicit Next; self and longer cycles stop visibly and restart without automatic reads', async () => {
  for (const loop of [
    ['a', 'a'],
    ['a', 'b', 'a'],
  ]) {
    directory = (input) => ready([], input.cursor === undefined ? loop[0]! : loop[loop.indexOf(input.cursor) + 1]!);
    if (calls.length) await click(restart());
    else await paint();
    await settle(() => !!next() && !next().disabled);
    const before = directories().length;
    for (let i = 0; i < loop.length - 1; i++) {
      await click(next());
      await settle(() =>
        i === loop.length - 2 ? host.textContent!.includes(m.relation_window_cycle()) : !next().disabled,
      );
    }
    await settle(() => host.textContent!.includes(m.relation_window_cycle()));
    expect(next().disabled).toBe(true);
    expect(restart().disabled).toBe(false);
    expect(directories()).toHaveLength(before + loop.length - 1);
    await click(next());
    expect(directories()).toHaveLength(before + loop.length - 1);
  }
});

test('64 successful reads include the first, exclude failures, and keep directory queries and rows bounded across restart', async () => {
  let success = 0;
  directory = () => ready(success++ === 0 ? Array.from({ length: 20 }, (_, i) => String(i)) : [], `cursor-${success}`);
  await paint();
  await settle(() => boxes().length === 20);
  await click(boxes()[0]!);
  const selectedCalls = calls.filter((input) => input.selected).length;
  for (let page = 1; page < 64; page++) {
    if (page === 10) {
      const produce = directory;
      directory = () => ({ kind: 'failed' });
      await click(next());
      await settle(() => !!retryDirectory());
      directory = produce;
      await click(retryDirectory());
    } else await click(next());
    await settle(() => (page === 63 ? host.textContent!.includes(m.relation_window_limit()) : !next().disabled));
    expect(boxes()).toHaveLength(0);
    expect(
      cache
        .getQueryCache()
        .findAll({ queryKey: ['subject-rating-populations'] })
        .filter((query) => query.queryKey[6] === 'directory').length,
    ).toBeLessThanOrEqual(2);
  }
  expect(success).toBe(64);
  expect(directories()).toHaveLength(65);
  expect(host.textContent).toContain(m.relation_window_limit());
  expect(next().disabled).toBe(true);
  await click(next());
  expect(success).toBe(64);
  await click(restart());
  await settle(() => !next().disabled);
  expect(directories().at(-1)?.cursor).toBeUndefined();
  expect(comparisons()).toHaveLength(1);
  expect(calls.filter((input) => input.selected)).toHaveLength(selectedCalls);
});

test('comparison refusal conceals retained choices while next is pending; directory withdrawal cannot revive an accepted page on restart', async () => {
  await paint();
  await settle(() => boxes().length === 2);
  await click(boxes()[0]!);
  await settle(() => comparisons().length === 1);
  const held = deferred<PopulationEnvelope['result']>();
  directory = () => held.promise;
  await click(next());
  denied.add('first');
  await click(button(m.subject_section_retry()));
  await settle(() => comparisons().length === 0);
  expect(boxes()).toHaveLength(1);
  held.resolve({ kind: 'unavailable' });
  await settle(() => boxes().length === 0);
  const fresh = deferred<PopulationEnvelope['result']>();
  directory = () => fresh.promise;
  await click(restart());
  expect(boxes()).toHaveLength(0);
  fresh.resolve(ready(['new']));
  await settle(() => boxes().length === 1);
  expect(host.textContent).not.toContain('Realm first');
});
