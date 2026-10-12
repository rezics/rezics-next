import { direction } from '@rezics/main/language';
import { expect, test } from 'bun:test';
import { catalogueCountProperty } from './catalogue-count.ts';

// A record's direction is what its language and text give, as the package's own records carry it.
const ja = { language: 'ja', direction: direction('ja', '話数') };
const en = { language: 'en', direction: direction('en', 'Episodes') };

const definition = 'https://rezics.com/id/01990000-0000-7000-8000-0000000000a1';

function property(projection: Record<string, unknown> = {}) {
  return {
    kind: 'property',
    definition,
    rendering: {
      viewingRole: 'subject',
      meaning: { definition },
      projections: [{
        fromRole: 'subject', toRole: 'value', reviewStatus: null, language: null,
        direction: null, fallback: { reason: 'missing-direction' }, labels: null, ...projection,
      }],
    },
  };
}

test('a public count property is its statement predicate, even when the name is not reviewed', () => {
  expect(catalogueCountProperty(property(), 'en')).toEqual({ predicate: definition, name: null });
});

test('a reviewed name in the page language is the count label', () => {
  const named = catalogueCountProperty(property({
    reviewStatus: 'reviewed', ...ja, fallback: null,
    labels: { noun: '話数' },
  }), 'ja');
  expect(named).toEqual({ predicate: definition, name: { value: '話数', lang: 'ja', dir: ja.direction } });
});

test('a name in another language, a fallback, or a draft is not this page\'s word', () => {
  const other = property({
    reviewStatus: 'reviewed', ...en, fallback: null, labels: { noun: 'Episodes' },
  });
  const fallback = property({
    reviewStatus: 'reviewed', ...en, fallback: { reason: 'language-fallback' },
    labels: { noun: 'Episodes' },
  });
  const draft = property({
    reviewStatus: 'draft', ...ja, fallback: null, labels: { noun: '下書き' },
  });
  expect(catalogueCountProperty(other, 'ja')).toEqual({ predicate: definition, name: null });
  expect(catalogueCountProperty(fallback, 'en')).toEqual({ predicate: definition, name: null });
  expect(catalogueCountProperty(draft, 'ja')).toEqual({ predicate: definition, name: null });
});

test('a relation, a misnamed property, or a mismatched meaning is not a count', () => {
  expect(catalogueCountProperty({ ...property(), kind: 'relation' }, 'en')).toBeNull();
  expect(catalogueCountProperty({
    kind: 'property', definition,
    rendering: { viewingRole: 'source', meaning: { definition },
      projections: [{ fromRole: 'source', toRole: 'target' }] },
  }, 'en')).toBeNull();
  expect(catalogueCountProperty({
    kind: 'property', definition,
    rendering: { viewingRole: 'subject', meaning: { definition: 'https://rezics.com/id/other' },
      projections: [{ fromRole: 'subject', toRole: 'value' }] },
  }, 'en')).toBeNull();
  expect(catalogueCountProperty({
    kind: 'property', definition,
    rendering: { viewingRole: 'subject', meaning: { definition }, projections: [] },
  }, 'en')).toBeNull();
  expect(catalogueCountProperty(null, 'en')).toBeNull();
});
