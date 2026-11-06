import { afterAll, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, useState } from 'react';

// Composed controls keep their mounted state when a route or preview rebuilds an equal component registry.
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/threads/one/reading' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
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
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

function Probe() {
  const [count, setCount] = useState(0);
  return (
    <button type="button" data-slot="probe" onClick={() => setCount(count + 1)}>
      {`count ${count}`}
    </button>
  );
}

test('a composed control keeps its mounted state when its parent rebuilds an equal registry', async () => {
  const { createRoot } = await import('react-dom/client');
  const { CompositionRender } = await import('../src/features/pages/render');
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  // The document and definitions are the same objects on every render; only the registry object is rebuilt.
  const pageDocument = { root: { props: {} }, content: [{ type: 'Probe', props: { id: 'probe' } }] };
  const definitions = [{ type: 'Probe' }];
  const render = () =>
    act(async () => {
      root.render(<CompositionRender document={pageDocument} definitions={definitions} components={{ Probe }} />);
    });

  await render();
  const button = host.querySelector<HTMLButtonElement>('button[data-slot="probe"]')!;
  await act(async () => button.click());
  expect(button.textContent).toBe('count 1');

  await render();
  expect(host.querySelector('button[data-slot="probe"]')).toBe(button);
  expect(button.textContent).toBe('count 1');
  await act(async () => root.unmount());
});

afterAll(async () => {
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
