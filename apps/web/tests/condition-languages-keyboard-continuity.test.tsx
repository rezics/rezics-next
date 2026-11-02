import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { ConditionLanguages } from '../src/search/condition-languages';
import { m } from '../src/paraglide/messages.js';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/search' });
for (const [key, value] of Object.entries({
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  Element: window.Element,
  Node: window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
}))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const { createRoot } = await import('react-dom/client');
const host = window.document.createElement('main') as unknown as HTMLElement;
window.document.body.append(host);
const root = createRoot(host);
const held = { languages: ['en-GB', 'EN', 'xx-unsup'] };
const render = () =>
  root.render(
    <ConditionLanguages
      languages={held.languages}
      locale="en"
      onChange={(languages) => {
        held.languages = languages;
        render();
      }}
    />,
  );
const tags = () => [...host.querySelectorAll('li code')].map((node) => node.textContent);
const row = (tag: string) =>
  [...host.querySelectorAll('li')].find((item) => item.querySelector('code')?.textContent === tag)!;
const control = (scope: ParentNode, name: string) =>
  [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.getAttribute('aria-label') === name,
  )!;
const press = async (button: HTMLButtonElement) =>
  act(() => {
    button.focus();
    button.click();
  });

test('keyboard reorder and removal keep focus on the surviving control with exact authored order', async () => {
  await act(() => render());
  expect(tags()).toEqual(held.languages);

  await press(control(row('EN'), m.condition_languages_move_down({ language: 'EN' })));
  expect(tags()).toEqual(['en-GB', 'xx-unsup', 'EN']);
  expect(document.activeElement).toBe(control(row('EN'), m.condition_languages_move_up({ language: 'EN' })));

  await press(control(row('EN'), m.condition_languages_move_up({ language: 'EN' })));
  expect(tags()).toEqual(['en-GB', 'EN', 'xx-unsup']);
  expect(document.activeElement).toBe(control(row('EN'), m.condition_languages_move_up({ language: 'EN' })));

  const focused = document.activeElement;
  held.languages = [...held.languages];
  await act(() => render());
  expect(document.activeElement).toBe(focused);
  expect(tags()).toEqual(['en-GB', 'EN', 'xx-unsup']);

  await press(control(row('en-GB'), m.condition_languages_remove({ language: 'en-GB' })));
  expect(tags()).toEqual(['EN', 'xx-unsup']);
  expect(document.activeElement).toBe(control(row('EN'), m.condition_languages_remove({ language: 'EN' })));

  await press(control(row('xx-unsup'), m.condition_languages_remove({ language: 'xx-unsup' })));
  expect(tags()).toEqual(['EN']);
  expect(document.activeElement).toBe(control(row('EN'), m.condition_languages_remove({ language: 'EN' })));

  await press(control(row('EN'), m.condition_languages_remove({ language: 'EN' })));
  expect(tags()).toEqual([]);
  expect(document.activeElement).toBe(host.querySelector('select'));
});
