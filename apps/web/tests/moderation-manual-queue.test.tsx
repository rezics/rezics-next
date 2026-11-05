import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import type { WorkbenchSearch } from '../src/moderation/workbench-queue/scope';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { workbenchSearch } = await import('../src/moderation/workbench-queue/scope');
const { m } = await import('../src/paraglide/messages.js');

test('manual queue entry preserves discovery return and retires with its private visit', async () => {
  const search = workbenchSearch({ realm: 'discovery-realm', directoryCursor: 'directory-frontier' });
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const browser = new Window({ url: 'https://site.test/en/moderation/workbench' });
  const globals = {
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    Element: browser.Element,
    Node: browser.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { ManualModerationScope } = await import('../src/moderation/workbench-queue/manual-scope');
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const selected: WorkbenchSearch[] = [];
  let current = true;
  try {
    await act(async () =>
      root.render(
        createElement(ManualModerationScope, {
          search,
          onSearch: (value) => selected.push(value),
          isCurrent: () => current,
        }),
      ),
    );
    const input = host.querySelector('input')!;
    const select = host.querySelector('select')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')!.set!.call(input, 'board-exact');
      input.dispatchEvent(new browser.Event('input', { bubbles: true }));
      select.value = 'appeals';
      select.dispatchEvent(new browser.Event('change', { bubbles: true }));
    });
    const submit = () =>
      host.querySelector('form')!.dispatchEvent(new browser.Event('submit', { bubbles: true, cancelable: true }));
    await act(async () => {
      submit();
    });
    expect(selected[0]).toMatchObject({
      board: 'board-exact',
      queue: 'appeals',
      directoryCursor: 'directory-frontier',
      directoryRealm: 'discovery-realm',
    });
    const catalogue = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === m.moderation_manual_catalogue(),
    )!;
    await act(async () => catalogue.click());
    expect(selected[1]).toMatchObject({ scope: 'catalogue', queue: 'reports', directoryCursor: 'directory-frontier' });
    current = false;
    await act(async () => {
      submit();
      catalogue.click();
    });
    expect(selected).toHaveLength(2);
  } finally {
    await act(async () => root.unmount());
    await browser.happyDOM.close();
    for (const [key, descriptor] of saved)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
  }
});
