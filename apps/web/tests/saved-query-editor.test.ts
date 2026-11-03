import { expect, test } from 'bun:test';
import { parseFilter } from '@rezics/filter';
import {
  admitSavedQuerySelection,
  hasSavedQueryInput,
  savedQueryCreateHref,
  savedQuerySeed,
} from '../src/library/saved-query-editor/selection';
import { locales } from '../src/paraglide/runtime.js';

const document = parseFilter({ statement: { property: 'schema:keywords', in: ['space opera'] } });
const presence = { owner: { presence: true } };
const book = { type: { in: ['schema:Book'] } };

test('saved query admission carries the exact filter document and displayed type, never label text', () => {
  const selection = admitSavedQuerySelection({
    document,
    type: 'schema:Book',
    search: '?l.schema%3Akeywords=Space+Opera&cursor=next&layout=list',
  });
  expect(selection).toEqual({
    state: 'admitted',
    filter: parseFilter({ and: [presence, { and: [book, document] }] }),
    sort: 'id',
  });
  expect(savedQuerySeed(null, selection)).toEqual(selection.state === 'admitted' ? selection.filter : undefined);
  expect(savedQuerySeed('existing', selection)).toBeUndefined();
});

test('text, resource, unknown, invalid, and non-id sort selections remain unrepresentable', () => {
  for (const search of ['?q=space', '?resource=realm%3Aone', '?scope=library', '?state=reading', '?sort=rating']) {
    expect(admitSavedQuerySelection({ document, type: 'schema:Book', search }).state).toBe('invalid');
    expect(hasSavedQueryInput({ document, search })).toBe(true);
  }
  expect(admitSavedQuerySelection({ document, type: 'schema:Book', search: '?sort=id' })).toMatchObject({
    state: 'admitted',
    sort: 'id',
  });
});

test('every launch locale has a predicate-free create address and reload guidance', async () => {
  expect(locales).toHaveLength(8);
  for (const locale of locales) {
    const messages = (await Bun.file(new URL(`../messages/${locale}.json`, import.meta.url)).json()) as Record<
      string,
      string
    >;
    expect(messages.library_saved_query_create.length).toBeGreaterThan(0);
    expect(messages.library_saved_query_invalid.length).toBeGreaterThan(0);
    expect(messages.library_saved_query_reloaded.length).toBeGreaterThan(0);
    const href = savedQueryCreateHref(locale);
    expect(href).toBe(`/${locale}/library/rules/new`);
    expect(href).not.toContain('?');
    expect(href).not.toContain('filter=');
  }
});
