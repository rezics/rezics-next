import { afterAll, afterEach, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, type ReactNode } from 'react';
import type { BoardChoiceSource } from '../src/community/setup-board-picker';

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
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');
const host = window.document.createElement('main') as unknown as HTMLElement;
window.document.body.append(host);
let root: ReturnType<typeof createRoot> | undefined;

type Choice = { id: string; label: string };
type SchemePage = { schemes: readonly Choice[]; next: string | null };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}
function sourceFor(choice: Choice, continuation: Promise<SchemePage>): BoardChoiceSource {
  return {
    schemes: async ({ cursor }) => (cursor === undefined ? { schemes: [choice], next: 'next-cursor' } : continuation),
    concepts: async () => ({ concepts: [], next: null }),
  };
}
async function tick(milliseconds = 0) {
  await act(async () => await new Promise((done) => setTimeout(done, milliseconds)));
}
async function paint(node: ReactNode) {
  setLocale('en', { reload: false });
  root ??= createRoot(host);
  await act(async () => root!.render(node));
}
function button(label: string) {
  return [...host.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim() === label)!;
}
async function activateKeyboard(node: HTMLElement) {
  await act(async () => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 0 })));
  await tick();
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
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

test('moved focus stays put while a keyboard Board Next page is pending', async () => {
  const continuation = deferred<SchemePage>();
  await paint(
    <SetupBoardPicker
      kind="scheme"
      source={sourceFor({ id: 'first', label: 'First board' }, continuation.promise)}
      value={null}
      disabled={false}
      onChange={() => {}}
    />,
  );
  await tick(280);
  await activateKeyboard(button(m.space_setup_board_choice_next()));
  const search = host.querySelector<HTMLInputElement>('input[type="search"]')!;
  await act(async () => search.focus());
  continuation.resolve({ schemes: [], next: null });
  await tick();
  expect(window.document.activeElement).toBe(search);
});

test('pointer activity cancels a keyboard Board Next focus handoff', async () => {
  const continuation = deferred<SchemePage>();
  await paint(
    <SetupBoardPicker
      kind="scheme"
      source={sourceFor({ id: 'first', label: 'First board' }, continuation.promise)}
      value={null}
      disabled={false}
      onChange={() => {}}
    />,
  );
  await tick(280);
  await activateKeyboard(button(m.space_setup_board_choice_next()));
  await act(async () => window.document.body.dispatchEvent(new window.Event('pointerdown', { bubbles: true })));
  continuation.resolve({ schemes: [], next: null });
  await tick();
  expect(window.document.activeElement).not.toBe(host.querySelector('[role="region"]'));
});

test('replacement scope retires a late keyboard page without reclaiming focus', async () => {
  const retired = deferred<SchemePage>();
  await paint(
    <SetupBoardPicker
      kind="scheme"
      schemeId="first-scope"
      source={sourceFor({ id: 'first', label: 'First board' }, retired.promise)}
      value={null}
      disabled={false}
      onChange={() => {}}
    />,
  );
  await tick(280);
  await activateKeyboard(button(m.space_setup_board_choice_next()));
  await paint(
    <SetupBoardPicker
      kind="scheme"
      schemeId="replacement-scope"
      source={sourceFor(
        { id: 'replacement', label: 'Replacement board' },
        Promise.resolve({ schemes: [], next: null }),
      )}
      value={null}
      disabled={false}
      onChange={() => {}}
    />,
  );
  await tick(280);
  expect(host.textContent).toContain('Replacement board');
  retired.resolve({ schemes: [{ id: 'retired', label: 'Retired board' }], next: null });
  await tick();
  expect(host.textContent).not.toContain('Retired board');
  expect(window.document.activeElement).not.toBe(host.querySelector('[role="region"]'));
});
