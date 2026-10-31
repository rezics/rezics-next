import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseListPresentation } from '@rezics/ui/cover';
import { CollectionMemberDetails } from '../src/library/collection-member-row';
import { collectionMemberRatio, type CollectionListPresentations } from '../src/library/collection-presentation';
import { subjectOf, type CollectionMember } from '../src/library/reads';
import { getLocale, locales, setLocale } from '../src/paraglide/runtime.js';
import recording from '../src/kernel/recorded/library-collection-members.json';
import definitions from '../src/kernel/recorded/definitions-release.json';

mock.module('cloudflare:workers', () => ({ env: { PUBLIC_ORIGIN: 'https://rezics.test' } }));
const { CollectionReadMembers } = await import('../src/library/collection-page');

const presentations: CollectionListPresentations = {
  'schema:Book': parseListPresentation(definitions.release.types['schema:Book'].listPresentation)!,
  'schema:Movie': parseListPresentation(definitions.release.types['schema:Movie'].listPresentation)!,
};
const book = { ...recording.members[2]!, subject: subjectOf(recording.members[2]!.subject) };
const renderDetails = (member: Pick<CollectionMember, 'subject' | 'facts'>, listPresentations = presentations) =>
  renderToStaticMarkup(createElement(CollectionMemberDetails, { member, listPresentations }));

test('Book and Film facts use released order, localized supplied labels and existing number/unit formatting', () => {
  const previous = getLocale();
  const labels = Object.fromEntries(locales.map((locale) => [locale, `Supplied credit (${locale})`]));
  try {
    for (const locale of locales) {
      setLocale(locale, { reload: false });
      for (const [type, credit, amount, unit] of [
        ['schema:Book', 'schema:author', 123456, 'words'],
        ['schema:Movie', 'schema:director', 95.5, 'min'],
      ] as const) {
        const quantity = type === 'schema:Book' ? 'schema:wordCount' : 'schema:duration';
        const html = renderDetails({
          subject: { ...book.subject!, type },
          facts: {
            [quantity]: [{ kind: 'quantity', amount, unit }],
            'schema:datePublished': [{ kind: 'time', year: 1943 }],
            [credit]: [{ kind: 'item', id: 'supplied-credit', labels }],
            'schema:genre': [{ kind: 'code', value: 'Unconfigured value' }],
          },
        });
        const year = new Intl.NumberFormat(locale, { useGrouping: false }).format(1943);
        const number = `${new Intl.NumberFormat(locale).format(amount)} ${unit}`;
        expect(html).toContain(labels[locale]!);
        expect(html).toContain(`lang="${locale}"`);
        expect(html).toContain(year);
        expect(html).toContain(number);
        expect(html.indexOf(labels[locale]!)).toBeLessThan(html.indexOf(year));
        expect(html.indexOf(year)).toBeLessThan(html.indexOf(number));
        expect(html).not.toContain('Unconfigured value');
      }
    }
  } finally {
    setLocale(previous, { reload: false });
  }
});

test('absent, complete-empty, withheld and explicitly cleared facts stay absent without title heuristics', () => {
  for (const facts of [undefined, {}, { 'schema:author': [], 'schema:datePublished': [] }]) {
    const html = renderDetails({ subject: book.subject, ...(facts === undefined ? {} : { facts }) });
    expect(html).not.toContain('member-list-row-facts');
    expect(html).not.toContain('1943');
  }
  const supplied: Pick<CollectionMember, 'subject' | 'facts'> = {
    subject: book.subject,
    facts: { 'schema:datePublished': [{ kind: 'time', year: 1943 }] },
  };
  const cleared = { 'schema:Book': { imageAspect: 'portrait' as const, keyFacts: [] } };
  expect(renderDetails(supplied, cleared)).not.toContain('1943');
  expect(renderDetails({ ...supplied, subject: null })).toBe('');
  const partial = renderDetails(supplied);
  expect(partial).toContain('1943');
  expect(partial).not.toContain('author');
  expect(partial).not.toContain('Unknown');
  const invalid = renderDetails({
    subject: book.subject,
    facts: {
      'schema:author': [{ kind: 'item', id: 'unlabelled', labels: {} }],
      'schema:datePublished': [{ kind: 'time', year: NaN }],
      'schema:wordCount': [{ kind: 'quantity', amount: Infinity, unit: 'words' }],
    },
  });
  expect(invalid).not.toContain('member-list-row-facts');
});

test('Collection geometry follows actual Type hints while owner/dominant Collection kind leaves member facts intact', () => {
  const member = {
    ...book,
    facts: { 'schema:datePublished': [{ kind: 'time' as const, year: 1943 }] },
  };
  const configured: CollectionListPresentations = {
    ...presentations,
    'schema:Book': { imageAspect: 'square', keyFacts: ['schema:datePublished'] },
  };
  expect(collectionMemberRatio(member.subject, {}, configured)).toBe('1:1');
  expect(collectionMemberRatio({ type: 'schema:Movie' }, {}, presentations)).toBe('16:9');
  expect(collectionMemberRatio({ type: 'concept:Book' }, {}, presentations)).toBe('1:1');
  for (const presentationKind of ['schema:Book', 'schema:Movie', null]) {
    const html = renderToStaticMarkup(
      createElement(CollectionReadMembers, {
        members: [member],
        layout: 'grid',
        presentationKind,
        listPresentations: configured,
        onCopy: () => {},
      }),
    );
    expect(html).toContain('data-ratio="1:1"');
    expect(html).toContain('1943');
    expect(html).toContain(book.note!);
    expect(html).toContain(`/subjects/${book.subject!.id}/`);
    expect(html).not.toContain('<img');
  }
});
