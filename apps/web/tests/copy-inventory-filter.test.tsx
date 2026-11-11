import { selectTrigger, selectValue, selectOptions, chooseSelect } from './support/select';
import { afterAll, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CopyInventoryFilters } from '../src/library/copy-inventory-filters';
import type { CopyInventoryOptions } from '../src/library/copy-inventory-filters';
import { m } from '../src/paraglide/messages.js';
import { getLocale, overwriteGetLocale } from '../src/paraglide/runtime.js';
const originalGetLocale = getLocale;

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window();
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  DocumentFragment: window.DocumentFragment,
  ShadowRoot: window.ShadowRoot,
  Document: window.Document,
  NodeFilter: window.NodeFilter,
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  getComputedStyle: window.getComputedStyle.bind(window),
  ResizeObserver: window.ResizeObserver,
  MutationObserver: window.MutationObserver,
  HTMLInputElement: window.HTMLInputElement,
  Node: window.Node,
  Element: window.Element,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import('react-dom/client');
afterAll(async () => {
  overwriteGetLocale(originalGetLocale);
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
const query = {
  subjectId: '0192f3a0-6c1e-7b2a-9d4e-000000000011',
  kind: 'old.print',
  status: 'loan',
  cursor: 'old',
};
const filterOptions: CopyInventoryOptions = {
  kinds: {
    state: 'available',
    choices: [
      { id: 'old.print', label: 'Ancien papier', labelLanguage: 'fr', meaning: 'available' },
      { id: 'retired', label: 'Retired medium', meaning: 'unsupported' },
      { id: 'lost', label: 'Lost meaning', meaning: 'unavailable' },
    ],
  },
  statuses: { state: 'unavailable', choices: [] },
};
const props = {
  subjectId: query.subjectId!,
  kind: query.kind!,
  status: query.status!,
  filterOptions,
  current: () => true,
};

test('bounded named controls use native historical labels and meanings, retaining exact IDs without labels', async () => {
  for (const locale of ['en', 'zh-Hant'] as const) {
    overwriteGetLocale(() => locale);
    const host = window.document.createElement('main');
    window.document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<CopyInventoryFilters {...props} />));
    try {
      const form = host.querySelector('form')!;
      expect(form.getAttribute('action')).toBe(`/${locale}/library/copies`);
      expect(form.getAttribute('method')).toBe('get');
      expect(form.querySelector('[name="subjectId"]')?.getAttribute('value')).toBe(query.subjectId);
      expect(form.querySelector('[name="cursor"]')).toBeNull();
      for (const select of host.querySelectorAll('[data-slot="select-trigger"]')) {
        expect(host.querySelector(`label[for="${select.id}"]`)?.textContent).toBeTruthy();
        expect(host.querySelector(`[id="${select.getAttribute('aria-describedby')}"]`)?.textContent).toBeTruthy();
      }
      const kinds = selectTrigger(host);
      expect(selectValue(kinds)).toBe('old.print');
      expect(kinds.textContent).toContain(m.library_copy_filter_available());
      expect(selectValue(selectTrigger(host, 1))).toBe('loan');
      expect(host.textContent).toContain(`loan — ${m.library_copy_filter_unavailable()}`);
      expect(host.textContent).toContain(m.library_copy_filter_options_unavailable());
      const options = await selectOptions(kinds);
      expect(options.find((item) => item.dataset.value === 'old.print')?.getAttribute('lang')).toBe('fr');
      expect(options.map((item) => item.textContent).join(' ')).toContain(m.library_copy_filter_unsupported());
      expect(options.map((item) => item.textContent).join(' ')).toContain(m.library_copy_filter_unavailable());
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  }
});

test('filter changes submit the exact Subject and other filter, omit empty predicates and restart the cursor; stale origins cannot submit', async () => {
  overwriteGetLocale(() => 'en');
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host);
  let current = true;
  try {
    await act(async () => root.render(<CopyInventoryFilters {...props} current={() => current} />));
    const kind = selectTrigger(host);
    await chooseSelect(kind, 'retired');
    const form = host.querySelector('form')!;
    expect([...new window.FormData(form).entries()]).toEqual([
      ['subjectId', query.subjectId!],
      ['kind', 'retired'],
      ['status', 'loan'],
    ]);
    await chooseSelect(kind, '');
    expect([...new window.FormData(form).keys()]).toEqual(['subjectId', 'status']);
    current = false;
    const event = new window.Event('submit', { bubbles: true, cancelable: true });
    await act(async () => {
      form.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('empty native inventories and unavailable inventories have distinct explanations', () => {
  const host = window.document.createElement('main');
  host.innerHTML = renderToStaticMarkup(
    <CopyInventoryFilters
      {...props}
      kind={null}
      status={null}
      filterOptions={{ kinds: { state: 'available', choices: [] }, statuses: { state: 'available', choices: [] } }}
    />,
  );
  expect(host.textContent).toContain(m.library_copy_filter_none());
  expect(host.textContent).not.toContain(m.library_copy_filter_options_unavailable());
  host.innerHTML = renderToStaticMarkup(<CopyInventoryFilters {...props} filterOptions={undefined} />);
  expect(selectValue(selectTrigger(host))).toBe('old.print');
  expect(host.textContent).toContain(m.library_copy_filter_options_unavailable());
  host.innerHTML = renderToStaticMarkup(
    <CopyInventoryFilters {...props} kind={null} status={null} filterOptions={undefined} />,
  );
  expect(host.querySelector('form')).toBeNull();
});
