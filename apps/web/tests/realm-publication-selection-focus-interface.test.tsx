import { afterAll, expect, test } from 'bun:test';
import { dirname } from 'node:path';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/spaces/shelf' });
const names =
  'document navigator location HTMLElement HTMLInputElement Element Node Document DocumentFragment HTMLButtonElement HTMLFormElement MutationObserver ResizeObserver KeyboardEvent Event';
const globals = {
  ...Object.fromEntries(names.split(' ').map((key) => [key, window[key as keyof typeof window]])),
  window,
  getComputedStyle: window.getComputedStyle.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const { act, useState } = await import('react');
const { createRoot } = await import('react-dom/client');
const { PublicationControls } = await import('../src/community/publication-controls-view');
type Target = import('../src/community/publication-controls-view').PublicationTarget;
type Control = ReturnType<typeof import('../src/community/publication-controls-view').usePublicationControls>;
const subject = { id: 'subject', title: 'Keyboard book', types: ['schema:Book'], typeLabel: 'Book', cover: null };
const host = document.createElement('main');
document.body.append(host);
let root: ReturnType<typeof createRoot>;
let retireOnChoose = false;

function Fixture() {
  const [target, setTarget] = useState<Target | null>(null);
  const [scope, setScope] = useState('current');
  const control = {
    target,
    scope,
    locked: false,
    busy: false,
    action: null,
    outcome: null,
    choose: (next: Target | null) => {
      setTarget(next);
      if (retireOnChoose) setScope('retired');
    },
  } as unknown as Control;
  return <PublicationControls control={control} refresh={async () => {}} search={async () => [subject]} />;
}

function press(button: HTMLButtonElement) {
  button.focus();
  button.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  button.click();
}

async function search(input: HTMLInputElement) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'book');
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 260));
  });
}

test('keyboard selection reviews the subject, clear returns to the picker, and close keeps its opener', async () => {
  root = createRoot(host);
  await act(async () => root.render(<Fixture />));
  const opener = host.querySelector<HTMLButtonElement>('button')!;
  await act(async () => press(opener));
  let input = host.querySelector<HTMLInputElement>('input')!;
  input.focus();
  await search(input);
  await act(async () => {
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  expect(document.activeElement).toBe(host.querySelector('[data-content-item-slot="title"]'));
  const clear = host.querySelector<HTMLButtonElement>('[data-content-item-slot="actions"] button')!;
  await act(async () => press(clear));
  input = host.querySelector<HTMLInputElement>('input')!;
  expect(document.activeElement).toBe(input);
  await act(async () => press(opener));
  expect(opener.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(opener);

  retireOnChoose = true;
  await act(async () => press(opener));
  input = host.querySelector<HTMLInputElement>('input')!;
  input.focus();
  await search(input);
  await act(async () => {
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  expect(document.activeElement).not.toBe(host.querySelector('[data-content-item-slot="title"]'));
});

afterAll(async () => {
  await act(async () => root?.unmount());
  host.remove();
  for (const [key, value] of previous) {
    if (value) Object.defineProperty(globalThis, key, value);
    else Reflect.deleteProperty(globalThis, key);
  }
});
