import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import type { LabelsPage } from '../src/library/labels-read';

test('Overflowing names read locally by touch and keyboard; fitting names keep only their shelf link', async () => {
  const { Window } = await import(Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir))));
  const window = new Window({ url: 'https://site.test/fr/library/labels' });
  const callbacks = new Set<() => void>();
  class Observer {
    constructor(private callback: () => void) {}
    observe() { callbacks.add(this.callback); }
    disconnect() { callbacks.delete(this.callback); }
  }
  let narrow = true;
  // Layout is supplied: real browser checks belong to integration.
  Object.defineProperties(window.HTMLElement.prototype, {
    clientHeight: { get: () => 40 },
    scrollHeight: { get() { return narrow && (this.textContent?.length ?? 0) > 30 ? 80 : 20; } },
  });
  const globals = {
    window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node,
    Document: window.Document, ShadowRoot: window.ShadowRoot, NodeFilter: window.NodeFilter,
    getComputedStyle: window.getComputedStyle.bind(window), ResizeObserver: Observer,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const io = mock(() => { throw new Error('Name reading must use only the supplied catalogue'); });
  mock.module('../src/library/labels-actions', () => ({ manageLabel: io }));
  mock.module('../src/library/labels-read-route', () => ({ readLabelsPage: io }));
  const { LabelsPageView } = await import('../src/library/labels-page');
  const { createRoot } = await import('react-dom/client');
  const { userEvent } = await import('storybook/test');
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const name = `  <名前> e\u0301 ${'📚無間隔'.repeat(190)}  `;
  const page: LabelsPage = {
    signedIn: true, operations: ['library_label.list'], csrfToken: '', createKey: '', undoKey: '', next: null,
    labels: [name, 'Short'].map((name, i) => ({ id: `label-${i}`, name, revision: 1, renameKey: '', deleteKey: '' })),
  };
  const render = (value = page) => act(async () => root.render(<LabelsPageView page={value} locale="fr" />));
  const user = userEvent.setup({ document: window.document as unknown as Document });
  const navigations: string[] = [];
  host.addEventListener('click', (event) => {
    if ((event.target as Element).closest('a')) { navigations.push('shelf'); event.preventDefault(); }
  });
  try {
    await render();
    const [long, short] = [...host.querySelectorAll('ul > li')];
    const control = long!.querySelector('button')!;
    const text = window.document.getElementById(control.getAttribute('aria-controls')!)!;
    expect(short!.querySelector('button')).toBeNull();
    expect(text.textContent).toBe(name);
    expect(text.closest('[lang]')?.getAttribute('lang')).toBe('fr');
    expect(text.className).toContain('whitespace-break-spaces [overflow-wrap:anywhere] line-clamp-2 sm:line-clamp-1');
    expect(control.closest('a')).toBeNull();
    expect(long!.querySelector('a')?.getAttribute('href')).toBe('/fr/library?label=label-0');
    await act(async () => user.pointer([{ keys: '[TouchA>]', target: control }, { keys: '[/TouchA]' }]));
    expect(control.getAttribute('aria-expanded')).toBe('true');
    expect(text.className).not.toContain('line-clamp');
    control.focus();
    await act(async () => user.keyboard(' '));
    expect(control.getAttribute('aria-expanded')).toBe('false');
    await act(async () => user.keyboard('{Enter}'));
    expect(control.getAttribute('aria-expanded')).toBe('true');
    expect(window.document.activeElement).toBe(control);
    expect(text.textContent).toBe(name);
    narrow = false;
    await act(async () => user.keyboard('{Enter}'));
    expect(window.document.activeElement).toBe(control);
    await act(async () => user.tab());
    await act(async () => callbacks.forEach((callback) => callback()));
    expect(long!.querySelector('button')).toBeNull();
    expect(host.querySelector('[role="dialog"], input[name="name"], textarea, script')).toBeNull();
    expect(navigations).toEqual([]);
    expect(io).not.toHaveBeenCalled();
    await render({ ...page, signedIn: false, labels: [], operations: [] });
    expect(host.textContent).not.toContain(name);
  } finally {
    await act(async () => root.unmount());
    mock.restore();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
