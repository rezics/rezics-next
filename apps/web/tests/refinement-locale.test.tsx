import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PropertyPicker } from '../src/search/refinement/property-picker';
import { Refinement } from '../src/search/refinement/refinement';
import { m } from '../src/paraglide/messages.js';
import { getLocale, setLocale } from '../src/paraglide/runtime.js';

const properties = [
  { property: 'type', labels: {}, mode: 'types' as const, datatype: 'type', units: [] },
  {
    property: 'schema:author',
    labels: { en: 'Author' },
    mode: 'values' as const,
    datatype: 'wikibase-item',
    units: [] as const,
  },
  {
    property: 'schema:datePublished',
    labels: { en: 'Published' },
    mode: 'range' as const,
    datatype: 'time',
    units: [] as const,
  },
];
const empty = {
  status: 'ready' as const,
  page: {
    facets: [{ property: 'schema:author', values: [], next: null }],
    as_of: '2026-10-31T00:00:00.000Z',
  },
};

function picker(locale: string) {
  return renderToStaticMarkup(createElement(PropertyPicker, { properties, locale, onSelect() {} }));
}

function refinement(locale: string, initial: typeof empty | { status: 'refused' }) {
  return renderToStaticMarkup(
    createElement(Refinement, {
      data: { key: 'locale', properties, initial },
      conditions: { facetValues: {} },
      query: 'reading',
      locale,
      load: async () => ({ status: 'unavailable' as const, code: 'fixture' }),
    }),
  );
}

test('refinement chrome follows the supplied locale while ambient English and authored labels stay put', () => {
  const previous = getLocale();
  setLocale('en', { reload: false });
  try {
    const ja = { locale: 'ja' as never };
    const japanese = picker('ja');
    expect(japanese).toContain(m.search_subject_types({}, ja));
    expect(japanese).toContain(m.refinement_property_find_label({}, ja));
    expect(japanese).toContain(m.refinement_choose_property({}, ja));
    expect(japanese).toContain('Author');
    expect(japanese).not.toContain(m.search_subject_types());
    expect(japanese).not.toContain(m.refinement_property_find_label());

    const values = refinement('ja', empty);
    expect(values).toContain(m.refinement_no_values({}, ja));
    expect(values).toContain(m.refinement_lower({}, ja));
    expect(values).toContain('Published');
    expect(values).not.toContain(m.refinement_no_values());
    expect(values).not.toContain(m.refinement_lower());

    const refused = refinement('ja', { status: 'refused' });
    expect(refused).toContain(m.refinement_refused({}, ja));
    expect(refused).not.toContain(m.refinement_refused());

    expect(picker('en')).toContain(m.search_subject_types());
    expect(refinement('en', empty)).toContain(m.refinement_no_values());
  } finally {
    setLocale(previous, { reload: false });
  }
});

test('property picker no-match text follows the supplied locale', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://search.test/en/search' });
  const globals = {
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const host = document.createElement('main');
  document.body.append(host);
  const ambient = getLocale();
  setLocale('en', { reload: false });
  let root: ReturnType<typeof createRoot> | undefined;
  try {
    const ja = { locale: 'ja' as never };
    root = createRoot(host);
    await act(async () => root!.render(createElement(PropertyPicker, { properties, locale: 'ja', onSelect() {} })));
    const search = host.querySelector<HTMLInputElement>('input[type="search"]')!;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(search, 'not on the roster');
      search.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    expect(host.querySelector('[role="status"]')?.textContent).toBe(m.refinement_property_find_no_match({}, ja));
    expect(host.textContent).not.toContain(m.refinement_property_find_no_match());
  } finally {
    if (root) await act(async () => root!.unmount());
    host.remove();
    window.happyDOM.abort();
    setLocale(ambient, { reload: false });
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
