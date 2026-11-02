import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/boards/reading' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  Element: window.Element,
  Node: window.Node,
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
const { CopyDiscussionLink } = await import('../src/threads/copy-discussion-link');
const { m } = await import('../src/paraglide/messages.js');
const host = document.createElement('main');
document.body.append(host);
const outside = document.createElement('button');
document.body.append(outside);
let root: ReturnType<typeof createRoot>;
let writes: { reject: (error: Error) => void; promise: Promise<void> }[];

function action(label: string) {
  const node = [...document.querySelectorAll<HTMLButtonElement>('button, [role="menuitem"]')].find(
    (item) => item.textContent === label || item.getAttribute('aria-label') === label,
  );
  expect(node).toBeDefined();
  return node!;
}
async function copy(keyboard: boolean) {
  await act(async () => action(m.thread_content_more_actions()).click());
  const item = action(m.thread_content_copy_link());
  await act(async () => {
    if (keyboard) {
      item.focus();
      item.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    } else {
      item.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true }));
      item.dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 1 }));
    }
  });
}
async function reject(index = 0) {
  await act(async () => {
    writes[index]!.reject(new Error('Denied'));
    await writes[index]!.promise.catch(() => {});
  });
  await act(async () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())));
}

beforeEach(async () => {
  writes = [];
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: () => {
        let reject!: (error: Error) => void;
        const promise = new Promise<void>((_resolve, fail) => (reject = fail));
        writes.push({ reject, promise });
        return promise;
      },
    },
  });
  root = createRoot(host);
  await act(async () => root.render(<CopyDiscussionLink href="/threads/one" />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  outside.blur();
});
afterAll(() => {
  window.happyDOM.abort();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('keyboard rejection selects recovery, while pointer activation keeps the same fallback without taking focus', async () => {
  await copy(true);
  await reject();
  const input = host.querySelector('input')!;
  expect(input.value).toBe('https://site.test/threads/one');
  expect(document.activeElement).toBe(input);
  expect(input.value.slice(input.selectionStart!, input.selectionEnd!)).toBe(input.value);
  expect(host.querySelector('[role="status"]')?.textContent).toBe(m.board_feed_copy_failed());

  await copy(false);
  await reject(1);
  expect(host.querySelector('input')?.value).toBe(input.value);
  expect(document.activeElement).not.toBe(host.querySelector('input'));
});

test('focus movement or pointer activity during a pending keyboard copy cancels only its focus handoff', async () => {
  await copy(true);
  await act(async () => outside.focus());
  await reject();
  expect(host.querySelector('input')?.value).toBe('https://site.test/threads/one');
  expect(document.activeElement).toBe(outside);

  await copy(true);
  await act(async () => outside.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true })));
  await reject(1);
  expect(host.querySelector('input')?.value).toBe('https://site.test/threads/one');
  expect(document.activeElement).not.toBe(host.querySelector('input'));
});

test('a retired href caller cannot focus or reveal recovery in its ABA replacement', async () => {
  await copy(true);
  await act(async () => root.render(<CopyDiscussionLink href="/threads/two" />));
  await act(async () => root.render(<CopyDiscussionLink href="/threads/one" />));
  await reject();
  expect(host.querySelector('input, [role="status"]')).toBeNull();
  expect(document.activeElement).not.toBe(action(m.thread_content_more_actions()));
});
