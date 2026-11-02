import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act } from 'react';
import { CollectionDescriptionReader } from '../src/library/collection-description-reader';
import { m } from '../src/paraglide/messages.js';

test('description disclosure preserves exact text and keyboard focus, and only offers expansion for overflow', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://rezics.example/en' });
  let narrow = true;
  let resize = () => {};
  Object.defineProperties(window.HTMLElement.prototype, {
    clientHeight: { configurable: true, get: () => 96 },
    scrollHeight: {
      configurable: true,
      get() {
        return narrow && this.textContent.length > 100 ? 400 : 24;
      },
    },
  });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { default: userEvent } = await import(
    createRequire(require.resolve('storybook/test')).resolve('@testing-library/user-event')
  );
  const user = userEvent.setup({ document: window.document });
  const { createRoot } = await import('react-dom/client');
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const show = (description: string | null) =>
    act(async () => root.render(<CollectionDescriptionReader description={description} />));
  try {
    const description = `  Intro\n\n\t<script>literal text</script>\n${'界'.repeat(19950)}  `;
    await show(description);
    const text = host.querySelector('p')!;
    const button = host.querySelector('button')!;
    expect(button.textContent).toBe(m.library_collection_description_reader_expand());
    expect(button.getAttribute('aria-controls')).toBe(text.id);
    expect(text.classList.contains('line-clamp-4')).toBe(true);
    expect(text.textContent).toBe(description);
    expect(host.querySelector('script')).toBeNull();
    button.focus();
    await act(async () => user.keyboard('{Enter}'));
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.textContent).toBe(m.library_collection_description_reader_collapse());
    expect(text.classList.contains('line-clamp-4')).toBe(false);
    expect(text.classList.contains('whitespace-pre-wrap')).toBe(true);
    expect(text.classList.contains('[overflow-wrap:anywhere]')).toBe(true);
    expect(text.textContent).toBe(description);
    expect(window.document.activeElement).toBe(button);
    await act(async () => user.keyboard(' '));
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(window.document.activeElement).toBe(button);
    narrow = false;
    await act(async () => resize());
    expect(host.querySelector('button')).toBeNull();
    narrow = true;
    await act(async () => resize());
    expect(host.querySelector('button')).not.toBeNull();
    await show('Short description');
    expect(host.querySelector('button')).toBeNull();
    expect(host.textContent).toBe('Short description');
    await show(null);
    expect(host.textContent).toBe('');
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await window.happyDOM.close();
  }
});
