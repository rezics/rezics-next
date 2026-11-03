import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseFilter } from '@rezics/filter';
import { SavedQueryCorrection } from '../src/library/saved-query-editor/correction';
import { SaveQueryLink } from '../src/library/saved-query-editor/link';
import {
  admitSavedQueryInput,
  localPath,
  savedQueryCreateHref,
  savedQuerySeed,
} from '../src/library/saved-query-editor/selection';
import { m } from '../src/paraglide/messages.js';
import { locales } from '../src/paraglide/runtime.js';

const presence = { owner: { presence: true } } as const;
const book = { type: { in: ['schema:Book'] } };
const keyword = parseFilter({
  statement: { property: 'schema:keywords', in: ['00000000-0000-4000-8000-000000000123'] },
});

test('catalogue and library type or label selections seed a private presence query; a state ID stays unsaved', () => {
  expect(admitSavedQueryInput({})).toEqual({ state: 'empty' });
  expect(admitSavedQueryInput({ filter: JSON.stringify(keyword) })).toEqual({
    state: 'admitted',
    filter: { and: [presence, keyword] },
  });
  expect(admitSavedQueryInput({ type: 'schema:Book' })).toEqual({
    state: 'admitted',
    filter: { and: [presence, book] },
  });
  const label = '10000000-0000-4000-8000-000000000001';
  expect(admitSavedQueryInput({ label })).toEqual({
    state: 'admitted',
    filter: { and: [presence, { owner: { label: { id: label } } }] },
  });
  const unrepresentable = admitSavedQueryInput({ type: 'schema:Book', state: 'reading' });
  expect(unrepresentable).toEqual({
    state: 'invalid',
    issues: [{ key: 'state', reason: 'unrepresentable' }],
  });
  expect(savedQuerySeed(null, unrepresentable)).toBeUndefined();
  expect(savedQuerySeed(null, admitSavedQueryInput({ type: 'schema:Book' }))).toEqual({ and: [presence, book] });
  expect(savedQuerySeed('saved', admitSavedQueryInput({ type: 'schema:Book' }))).toBeUndefined();
  expect(admitSavedQueryInput({ filter: '{' })).toEqual({
    state: 'invalid',
    issues: [{ key: 'filter', reason: 'invalid' }],
  });
  expect(localPath('https://evil.test/x')).toBeNull();
  expect(localPath('//evil.test')).toBeNull();
  expect(localPath('/en/collections/a?f.schema:keywords=1')).toBe('/en/collections/a?f.schema:keywords=1');
});

test('the private create address and correction copy exist in every launch locale', async () => {
  expect(locales).toHaveLength(8);
  for (const locale of locales) {
    const messages = (await Bun.file(new URL(`../messages/${locale}.json`, import.meta.url)).json()) as Record<
      string,
      string
    >;
    expect(messages.library_saved_query_create.length).toBeGreaterThan(0);
    expect(messages.library_saved_query_invalid.length).toBeGreaterThan(0);
    expect(messages.library_saved_query_state.length).toBeGreaterThan(0);
    expect(messages.library_saved_query_correct.length).toBeGreaterThan(0);
    expect(messages.library_saved_query_blank.length).toBeGreaterThan(0);
    const href = savedQueryCreateHref(locale, { document: keyword, from: '/en/collections/a' });
    expect(href.startsWith(`/${locale}/library/rules/new?`)).toBe(true);
    expect(href).toContain('filter=');
    expect(href).toContain('from=%2Fen%2Fcollections%2Fa');
  }
  const html = renderToStaticMarkup(createElement(SaveQueryLink, { document: keyword }));
  expect(html).toContain(m.library_saved_query_create());
  expect(html).toContain('/library/rules/new');
  expect(html).toContain('min-h-11');
});

test('an unrepresentable selection stays off the save form', () => {
  const invalid = renderToStaticMarkup(
    createElement(SavedQueryCorrection, {
      selection: { state: 'invalid', issues: [{ key: 'state', reason: 'unrepresentable' }] },
      originHref: '/en/library?state=reading',
    }),
  );
  expect(invalid).toContain(m.library_saved_query_invalid());
  expect(invalid).toContain(m.library_saved_query_state());
  expect(invalid).toContain(m.library_saved_query_correct());
  expect(invalid).toContain(m.library_saved_query_blank());
  expect(invalid).toContain('href="/en/library?state=reading"');
  expect(invalid).not.toMatch(/<form\b/);
  expect(invalid).not.toContain(m.library_collection_create());
});
