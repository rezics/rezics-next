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
let directory: (input: PopulationInput) => PopulationEnvelope['result'] | Promise<PopulationEnvelope['result']>;
const read = async (input: PopulationInput): Promise<PopulationEnvelope> => ({
  subject: input.id,
  question: input.question,
  reader: input.expectedReader,
  result: input.selected ? ready(input.selected) : await directory(input),
});
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
async function activate(node: HTMLElement) {
  node.focus();
  await act(async () => {
    node.click();
    await tick();
  });
}
beforeEach(() => {
  directory = () => ready(['first', 'second'], 'next-cursor');
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

test('delayed population Next cannot focus an obsolete page or steal focus after reader movement', async () => {
  await paint();
  await settle(() => boxes().length === 2);
  const held = deferred<PopulationEnvelope['result']>();
  directory = () => held.promise;
  await activate(next());
  const outside = window.document.createElement('button');
  outside.textContent = 'outside';
  host.append(outside);
  await act(async () => outside.focus());
  held.resolve(ready(['late'], null));
  await settle(() => boxes().some((box) => box.nextSibling?.textContent === 'Realm late'));
  expect(window.document.activeElement).toBe(outside);
  outside.remove();
});

test('focused Next, Restart and Retry recover keyboard focus including an empty terminal page and repeated failure', async () => {
  await paint();
  await settle(() => boxes().length === 2);
  directory = () => ready([], null);
  await activate(next());
  await settle(() => host.textContent!.includes(m.rating_population_empty_page()));
  expect(window.document.activeElement).toBe(restart());
  directory = () => ready(['home'], 'next-cursor');
  await activate(restart());
  await settle(() => boxes()[0]?.nextSibling?.textContent === 'Realm home');
  expect(window.document.activeElement).toBe(boxes()[0]);
  let failures = 0;
  directory = () => {
    if (failures < 2) {
      failures += 1;
      return { kind: 'failed' };
    }
    return ready(['recovered'], null);
  };
  await activate(next());
  await settle(() => !!retryDirectory());
  await activate(retryDirectory());
  await settle(() => retryDirectory() && failures === 2);
  await activate(retryDirectory());
  await settle(() => boxes()[0]?.nextSibling?.textContent === 'Realm recovered');
  expect(window.document.activeElement).toBe(boxes()[0]);
});

test('an older Next cannot consume a newer Restart focus intent', async () => {
  await paint();
  await settle(() => boxes().length === 2);
  const nextHold = deferred<PopulationEnvelope['result']>();
  const restartHold = deferred<PopulationEnvelope['result']>();
  directory = (input) => (input.cursor !== undefined ? nextHold.promise : restartHold.promise);
  await activate(next());
  await activate(restart());
  nextHold.resolve(ready(['obsolete'], null));
  await act(tick);
  expect(host.textContent).not.toContain('Realm obsolete');
  expect(window.document.activeElement).toBe(restart());
  restartHold.resolve(ready(['fresh'], null));
  await settle(() => boxes()[0]?.nextSibling?.textContent === 'Realm fresh');
  expect(window.document.activeElement).toBe(boxes()[0]);
  expect(host.textContent).not.toContain('Realm obsolete');
});
