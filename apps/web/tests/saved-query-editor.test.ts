import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseFilter } from '@rezics/filter';
import { CollectionRuleEditor, RuleEditLink } from '../src/library/collection-rule-editor';
import { SaveQueryLink } from '../src/library/saved-query-editor/link';
import {
  admitSavedQueryInput,
  localPath,
  savedQueryCreateHref,
} from '../src/library/saved-query-editor/selection';
import { unavailableRuleChoices } from '../src/library/collection-rule-read';
import { m } from '../src/paraglide/messages.js';
import { getLocale, locales, setLocale } from '../src/paraglide/runtime.js';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('../src/library/subject-label-input', () => ({
  subjectLabelInputIssue: () => undefined,
}));
const { SavedQueryEditor } = await import('../src/library/saved-query-editor/editor');

const presence = { owner: { presence: true } } as const;
const book = { type: { in: ['schema:Book'] } };
const keyword = parseFilter({
  statement: { property: 'schema:keywords', in: ['00000000-0000-4000-8000-000000000123'] },
});
const newPage = {
  state: 'new' as const,
  viewerId: 'owner',
  choices: unavailableRuleChoices(),
  intent: '10000000-0000-4000-8000-000000000001',
};

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
  expect(admitSavedQueryInput({ type: 'schema:Book', state: 'reading' })).toEqual({
    state: 'invalid',
    issues: [{ key: 'state', reason: 'unrepresentable' }],
  });
  expect(admitSavedQueryInput({ filter: '{' })).toEqual({
    state: 'invalid',
    issues: [{ key: 'filter', reason: 'invalid' }],
  });
  expect(localPath('https://evil.test/x')).toBeNull();
  expect(localPath('//evil.test')).toBeNull();
  expect(localPath('/en/collections/a?f.schema:keywords=1')).toBe('/en/collections/a?f.schema:keywords=1');
});

test('the private create address and correction copy exist in every launch locale', () => {
  const previous = getLocale();
  try {
    for (const locale of locales) {
      setLocale(locale, { reload: false });
      const href = savedQueryCreateHref(locale, { document: keyword, from: '/en/collections/a' });
      expect(href.startsWith(`/${locale}/library/rules/new?`)).toBe(true);
      expect(href).toContain('filter=');
      const html = renderToStaticMarkup(createElement(SaveQueryLink, { document: keyword }));
      expect(html).toContain(m.library_saved_query_create());
      expect(html).toContain(`/${locale}/library/rules/new`);
    }
  } finally {
    setLocale(previous, { reload: false });
  }
});

test('an unrepresentable selection stays off the save form; an admitted seed is reviewed before create', () => {
  const invalid = renderToStaticMarkup(
    createElement(SavedQueryEditor, {
      page: newPage,
      collectionId: null,
      selection: { state: 'invalid', issues: [{ key: 'state', reason: 'unrepresentable' }] },
      originHref: '/en/library?state=reading',
    }),
  );
  expect(invalid).toContain(m.library_saved_query_invalid());
  expect(invalid).toContain(m.library_saved_query_state());
  expect(invalid).toContain('href="/en/library?state=reading"');
  expect(invalid).not.toMatch(/<form\b/);
  expect(invalid).not.toContain(m.library_collection_create());

  const seeded = renderToStaticMarkup(
    createElement(CollectionRuleEditor, {
      page: newPage,
      viewerId: 'owner',
      collectionId: null,
      admitted: ['collection.create'],
      csrfToken: 'csrf',
      seed: { and: [presence, book] },
      save: async () => ({ ok: false, reason: 'unavailable' }),
      reload: async () => newPage,
    }),
  );
  expect(seeded).toContain('schema:Book');
  expect(seeded).toContain(m.library_rule_presence());
  expect(seeded).toContain(m.library_rule_private());
  expect(seeded).toContain(m.library_collection_create());
});

test('owned saved-dynamic collections keep an edit link and builtins do not', () => {
  const owned = { id: 'saved', curatorAccountId: 'owner', membershipKind: 'dynamic' };
  expect(
    renderToStaticMarkup(createElement(RuleEditLink, { collection: owned, viewerId: 'owner', allowed: true })),
  ).toContain('/collections/saved/rule');
  expect(
    renderToStaticMarkup(
      createElement(RuleEditLink, {
        collection: { ...owned, builtinKind: 'everything' },
        viewerId: 'owner',
        allowed: true,
      }),
    ),
  ).toBe('');
});
