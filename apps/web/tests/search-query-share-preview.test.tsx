import { afterAll, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { QuerySharePreview } from '../src/search/query-share-preview';
import type { QueryShare } from '../src/search/query-share';
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/search' });
for (const [key, value] of Object.entries({
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  Element: window.Element,
  Node: window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
}))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import('react-dom/client');
const host = document.createElement('main');
document.body.append(host);
const root = createRoot(host);
afterAll(async () => {
  await act(() => root.unmount());
  window.happyDOM.abort();
});
const share: QueryShare = {
  action: 'allowed',
  reason: 'ready',
  document: { text: '"complete text"', filter: null, languages: ['ja', 'en'], sort: null },
  parameters: 'q=%22complete+text%22&language=ja&language=en',
  selections: [],
};
const button = (text: string) => [...host.querySelectorAll('button')].find((node) => node.textContent === text)!;
const click = async (text: string) => {
  await act(async () => {
    button(text).focus();
    button(text).click();
  });
};

test('preview distinguishes the executed query, announces copy, and focuses selectable fallback and deliberate close', async () => {
  let copied = '';
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        copied = text;
      },
    },
  });
  await act(() => root.render(<QuerySharePreview locale="en" changed prepare={async () => share} />));
  await click('Share executed query');
  expect(host.textContent).toContain('Unapplied edits are excluded');
  expect(host.textContent).toContain('"complete text"');
  expect(document.activeElement?.getAttribute('role')).toBe('region');
  await click('Copy link');
  expect(copied).toBe('https://site.test/en/search?' + share.parameters);
  expect(host.textContent).toContain('Link copied.');
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async () => {
        throw new Error('refused');
      },
    },
  });
  await click('Copy link');
  expect(host.textContent).toContain('Copy was refused');
  const fallback = host.querySelector('textarea')!;
  expect(document.activeElement).toBe(fallback);
  expect(fallback.value).toBe(copied);
  await click('Close preview');
  expect(host.querySelector('textarea')).toBeNull();
  expect(document.activeElement).toBe(button('Share executed query'));
});

test('oversized state preserves the editor; replacing the reader retires pending preparation', async () => {
  let resolve!: (value: QueryShare) => void;
  await act(() =>
    root.render(
      <QuerySharePreview
        key="old-reader"
        locale="en"
        changed={false}
        prepare={() =>
          new Promise((done) => {
            resolve = done;
          })
        }
      />,
    ),
  );
  await click('Share executed query');
  await act(() =>
    root.render(
      <QuerySharePreview
        key="new-reader"
        locale="en"
        changed={false}
        prepare={async () => ({ ...share, action: 'disabled', reason: 'oversized', document: null, parameters: null })}
      />,
    ),
  );
  await act(() => resolve(share));
  expect(host.querySelector('[role=region]')).toBeNull();
  await click('Share executed query');
  expect(host.textContent).toContain('too large for a link');
  expect(host.querySelector('textarea')).toBeNull();
});
