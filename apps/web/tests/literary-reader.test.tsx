import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Item } from '../src/features/pages/overview';
import { ExactEditionLink, isExactEdition } from '../src/features/pages/cover-list';
import { literaryFixture } from '../src/kernel/fake/catalogue-literary-profile';
import {
  literaryAuthorityKey,
  literaryWorkIdentity,
  literaryReaderRetired,
} from '../src/features/catalogue/literary-reader/model';
import { LiteraryReader } from '../src/features/catalogue/literary-reader/view';
import { listView } from '../src/features/pages/views';

test('literary work identity keeps multilingual names, and only exact editions leave the bounded work window', () => {
  const subject = literaryFixture().publicRead().subject;
  subject.labels = { en: 'The harbour', ja: '港' };
  subject.aliases = { en: ['Harbour stories'] };
  subject.descriptions = { en: 'A novel about a changing port town.' };
  const identity = literaryWorkIdentity(subject, 'en');
  const markup = renderToStaticMarkup(
    createElement(LiteraryReader, {
      identity,
      locale: 'en',
      editionHref: `/en/subjects/${subject.id}/editions`,
      factsHref: `/en/subjects/${subject.id}/details`,
    }),
  );

  expect(identity.id).toBe(subject.id);
  expect(markup).toContain('lang="ja">港');
  expect(markup).toContain('Harbour stories');
  expect(markup).toContain('publication facts stay with the exact edition');
  expect(markup).not.toContain(subject.id);
  expect(listView('schema:workExample')).toBe('editions');

  const edition: Item = {
    id: '0192f3a0-6c1e-7b2a-9d4e-000000000910',
    label: { text: 'The harbour, first edition' },
    type: 'bf:Instance',
    notes: [],
    gated: false,
  };
  const work: Item = { ...edition, type: 'schema:Book' };
  expect(isExactEdition(edition)).toBe(true);
  expect(isExactEdition(work)).toBe(false);

  const href = `/en/subjects/${edition.id}/first-edition`;
  const link = renderToStaticMarkup(createElement(ExactEditionLink, { href, children: 'Open exact edition' }));
  expect(link).toContain(`href="${href}"`);
  expect(link).toContain('target="_blank"');
  expect(link).toContain('rel="noopener noreferrer"');
});

test('authority and locale changes retire the same reader source; a replacement source starts fresh', () => {
  const source = {};
  const captured = {
    source,
    subject: 'work-a',
    locale: 'en',
    context: null,
    authority: literaryAuthorityKey({ state: 'signed-out', csrfToken: null }),
  };

  expect(
    literaryReaderRetired(captured, {
      ...captured,
      authority: literaryAuthorityKey({ state: 'signed-in', subject: 'account-a', csrfToken: 'next' }),
    }),
  ).toBe(true);
  expect(literaryReaderRetired(captured, { ...captured, locale: 'ja' })).toBe(true);
  expect(literaryReaderRetired(captured, { ...captured, context: 'realm-a' })).toBe(true);
  expect(literaryReaderRetired(captured, { ...captured, source: {} })).toBe(false);
});
