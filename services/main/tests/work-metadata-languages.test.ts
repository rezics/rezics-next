import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { checkedEditionV2, checkedMetadataState, InvalidWorkMetadata, type MetadataEditionState }
  from '../src/modules/work/metadata-schema.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
const v1 = (): MetadataEditionState => ({ kind: 'edition', id: id(), status: 'active',
  title: { value: 'A Galactic Journey', language: 'en' }, contentLanguage: 'en', editionStatement: null,
  publisher: null, publicationYear: 2001, isbn13: null });

test('v1 editions stay a single nullable content language, and v2 admits a list', () => {
  const first = checkedMetadataState(v1());
  const cleared = checkedMetadataState({ ...v1(), contentLanguage: null });
  if (first.kind !== 'edition' || 'contentLanguages' in first) throw new Error('expected a v1 edition');
  if (cleared.kind !== 'edition' || 'contentLanguages' in cleared) throw new Error('expected a v1 edition');
  expect(first.contentLanguage).toBe('en');
  expect(cleared.contentLanguage).toBeNull();
  const edition = v1();
  const bilingual = checkedEditionV2({ kind: 'edition', id: edition.id, status: 'active', title: edition.title,
    contentLanguages: ['zh-hant', 'en'], isTranslation: false, originalLanguages: [], titleLanguage: 'zh-Hant',
    tracklistLanguage: null, editionStatement: null, publisher: null, publicationYear: 2001, isbn13: null });
  expect(bilingual.contentLanguages).toEqual(['en', 'zh-Hant']);
  const fields = { kind: 'edition' as const, id: edition.id, status: 'active' as const, title: edition.title,
    editionStatement: null, publisher: null, publicationYear: 2001, isbn13: null, titleLanguage: null,
    tracklistLanguage: null };
  expect(checkedEditionV2({ ...fields, contentLanguages: [], isTranslation: true, originalLanguages: ['und'] })
    .originalLanguages).toEqual(['und']);
  expect(() => checkedEditionV2({ ...fields, contentLanguages: ['mul'], isTranslation: false, originalLanguages: [] }))
    .toThrow(InvalidWorkMetadata);
  expect(() => checkedEditionV2({ ...fields, contentLanguages: ['en'], isTranslation: true, originalLanguages: [] }))
    .toThrow(InvalidWorkMetadata);
});
