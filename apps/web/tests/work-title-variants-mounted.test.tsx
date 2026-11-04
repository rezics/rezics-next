import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import { WorkNamesView } from '../src/features/catalogue/work-names/view';
import { workNames } from '../src/features/catalogue/work-names/model';
import { work } from './work-title-variants.test';

test('mounted disclosure exposes native language groups, copy controls and retired state without another heading', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window();
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import('react-dom/client');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    const props = { names: workNames(work(), 'en'), locale: 'en', sourcesHref: '/en/subjects/work/title/sources' };
    await act(async () => root.render(createElement(WorkNamesView, props)));
    expect(host.querySelector('summary')?.textContent).toBe('Titles and aliases');
    expect(host.querySelectorAll('h1')).toHaveLength(0);
    expect(host.querySelector('[lang="zh-Hant"]')?.getAttribute('dir')).toBe('auto');
    expect(host.textContent).toContain('Unknown');
    expect(host.textContent).toContain('fallback');
    const group = host.querySelectorAll('details')[1]!;
    group.open = true;
    const copy = group.querySelector('button')!;
    copy.focus();
    expect(document.activeElement).toBe(copy);
    expect(host.querySelector(`a[href="${props.sourcesHref}"]`)).not.toBeNull();
    await act(async () => root.render(createElement(WorkNamesView, { ...props, retired: true })));
    expect(host.textContent).not.toContain('海の物語');
    expect(host.textContent).toContain('retired');
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await window.happyDOM.close();
  }
});
