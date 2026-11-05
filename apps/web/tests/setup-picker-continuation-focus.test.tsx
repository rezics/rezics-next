import { afterAll, afterEach, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, type ReactNode } from 'react';
import type { BoardChoiceSource } from '../src/community/setup-board-picker';
import {
  ContextChoiceError,
  createSetupContextPicker,
  type ContextChoiceSource,
} from '../src/community/setup-context-picker';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/realms/new' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
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
const { SetupBoardPicker } = await import('../src/community/setup-board-picker-control');
const { SetupContextPickerField } = await import('../src/community/setup-context-picker-field');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');
const host = window.document.createElement('main') as unknown as HTMLElement;
window.document.body.append(host);
let root: ReturnType<typeof createRoot> | undefined;
const disposers: (() => void)[] = [];

async function tick(milliseconds = 0) {
  await act(async () => {
    await new Promise((done) => setTimeout(done, milliseconds));
  });
}
async function paint(node: ReactNode) {
  setLocale('en', { reload: false });
  root ??= createRoot(host);
  await act(async () => {
    root!.render(node);
  });
}
function button(label: string) {
  return [...host.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim() === label)!;
}
async function activateKeyboard(node: HTMLElement) {
  await act(async () => {
    node.dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 0 }));
  });
  await tick();
}
async function edit(value: string) {
  const input = host.querySelector<HTMLInputElement>('input[type="search"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await tick(280);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = undefined;
  for (const dispose of disposers.splice(0)) dispose();
  host.replaceChildren();
});
afterAll(() => {
  host.remove();
  window.happyDOM.abort();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('keyboard Board Next focuses its admitted sparse page and preserves the chosen value and query', async () => {
  const choice = { id: 'board-choice', label: 'Saved board choice' };
  const next = deferred<{ schemes: readonly (typeof choice)[]; next: string | null }>();
  const requests: { query: string; cursor?: string }[] = [];
  const source: BoardChoiceSource = {
    schemes: async ({ query, cursor }) => {
      requests.push({ query, ...(cursor === undefined ? {} : { cursor }) });
      return cursor === undefined ? { schemes: [choice], next: 'opaque-cursor' } : next.promise;
    },
    concepts: async () => ({ concepts: [], next: null }),
  };
  await paint(<SetupBoardPicker kind="scheme" source={source} value={choice} disabled={false} onChange={() => {}} />);
  await tick(280);
  await edit('draft query');
  await activateKeyboard(button(m.space_setup_board_choice_next()));
  next.resolve({ schemes: [], next: null });
  await tick();
  expect(window.document.activeElement).toBe(host.querySelector('[role="region"]'));
  expect(host.textContent).toContain(choice.label);
  expect(host.querySelector<HTMLInputElement>('input[type="search"]')!.value).toBe('draft query');
  expect(requests.at(-1)).toEqual({ query: 'draft query', cursor: 'opaque-cursor' });
});

test('Context Next, retry and restart keep focus on admitted pages and ignore a retired caller page', async () => {
  const choice = { id: 'context-choice', label: 'Chosen context' };
  const late = deferred<{ contexts: readonly (typeof choice)[]; next: string | null }>();
  const requests: { query: string; cursor?: string }[] = [];
  let firstPages = 0;
  const source: ContextChoiceSource = {
    search: async ({ query, cursor }) => {
      requests.push({ query, ...(cursor === undefined ? {} : { cursor }) });
      if (cursor === 'late-cursor') return late.promise;
      if (cursor !== undefined) throw new ContextChoiceError('unavailable');
      firstPages++;
      return { contexts: [choice], next: firstPages < 3 ? '' : 'late-cursor' };
    },
    resolve: async () => choice,
  };
  const picker = createSetupContextPicker(source);
  disposers.push(picker.dispose);
  await paint(<SetupContextPickerField picker={picker} disabled={false} />);
  await act(async () => {
    host.querySelector<HTMLInputElement>('input[type="search"]')!.focus();
  });
  await tick();
  await act(async () => {
    host.querySelector<HTMLButtonElement>('ul button')!.click();
  });
  await tick();
  await edit('draft query');
  await activateKeyboard(button(m.setup_context_next()));
  expect(window.document.activeElement).toBe(host.querySelector('[role="region"]'));
  await activateKeyboard(button(m.space_setup_retry()));
  expect(window.document.activeElement).toBe(host.querySelector('[role="region"]'));
  await activateKeyboard(button(m.setup_context_restart()));
  expect(window.document.activeElement).toBe(host.querySelector('[role="region"]'));
  expect(host.textContent).toContain(choice.label);
  expect(host.querySelector<HTMLInputElement>('input[type="search"]')!.value).toBe('draft query');
  expect(requests.slice(2, 5)).toEqual([
    { query: 'draft query', cursor: '' },
    { query: 'draft query', cursor: '' },
    { query: 'draft query' },
  ]);
  await activateKeyboard(button(m.setup_context_next()));
  const replacement = createSetupContextPicker({
    search: async () => ({ contexts: [], next: null }),
    resolve: async () => null,
  });
  disposers.push(replacement.dispose);
  await paint(<SetupContextPickerField picker={replacement} disabled={false} />);
  const sentinel = window.document.createElement('button');
  window.document.body.append(sentinel);
  sentinel.focus();
  late.resolve({ contexts: [choice], next: null });
  await tick();
  expect(window.document.activeElement).toBe(sentinel);
  sentinel.remove();
});
