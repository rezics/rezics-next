import { expect, test } from 'bun:test';
import { InvalidVocabularyInput, vocabularyDigest, type DefineVocabularyConceptInput } from '../src/modules/classification/vocabulary.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const creation: DefineVocabularyConceptInput = { actingSubject: id(1), scheme: null,
  labels: [{ language: 'en', value: 'Board' }], alternativeLabels: [], broader: [], narrower: [] };

test('retirement intent binds the exact Concept, head and state in the vocabulary digest', () => {
  const retirement = { ...creation, concept: { id: id(2), expectedHead: id(3) }, state: 'retired' as const };
  expect(vocabularyDigest(retirement)).not.toBe(vocabularyDigest(creation));
  expect(vocabularyDigest(retirement)).not.toBe(vocabularyDigest({ ...retirement,
    concept: { id: id(4), expectedHead: id(3) } }));
  expect(vocabularyDigest(retirement)).not.toBe(vocabularyDigest({ ...retirement,
    concept: { id: id(2), expectedHead: id(5) } }));
});

test('minimal retirement is canonical, validates references and binds legacy envelope fields', () => {
  const input = { concept: { id: id(2), expectedHead: id(3) }, state: 'retired' as const, actingSubject: id(1) };
  expect(vocabularyDigest(input)).toBe(vocabularyDigest({ actingSubject: id(1), state: 'retired',
    concept: { expectedHead: id(3), id: id(2) } }));
  expect(vocabularyDigest(input)).not.toBe(vocabularyDigest({ ...input, labels: creation.labels }));
  expect(() => vocabularyDigest({ ...input, concept: { id: 'foreign', expectedHead: id(3) } }))
    .toThrow(InvalidVocabularyInput);
  expect(() => vocabularyDigest({ ...input, actingSubject: 'foreign' })).toThrow(InvalidVocabularyInput);
});
