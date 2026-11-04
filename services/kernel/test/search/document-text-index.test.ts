import { describe, expect, it } from 'bun:test';
import {
  DOCUMENT_TEXT_RECIPE,
  type DocumentTextCoverage,
  type DocumentTextProjection,
} from '../../src/search/document-text.ts';
import { subjectPartition, type IndexedSubject, type SubjectSnapshot } from '../../src/search/source.ts';
import { documentActions } from '../../src/search/document.ts';

const subjectId = '00000000-0000-7000-8000-000000000000';
const references = [
  {
    candidate: '00000000-0000-7000-8000-000000000001',
    document: '00000000-0000-7000-8000-000000000011',
    digest: 'a'.repeat(64),
    language: 'en',
  },
  {
    candidate: '00000000-0000-7000-8000-000000000002',
    document: '00000000-0000-7000-8000-000000000012',
    digest: 'b'.repeat(64),
    language: 'fr',
  },
];

function indexed(coverage: DocumentTextCoverage, texts: readonly string[]): SubjectSnapshot {
  const partition = subjectPartition(subjectId);
  const subject: IndexedSubject = {
    id: subjectId,
    type: 'recipe',
    visibility: 'visible',
    redirect: null,
    securityRevision: 4,
    labels: [{ language: 'en', value: 'Recipe' }],
    aliases: [],
    descriptions: [],
    statements: [],
    documentText: {
      selection: { subject: subjectId, partition, securityRevision: 4, references },
      coverage,
      documents: texts.map((text, index) => ({
        reference: references[index]!,
        revision: 7 + index,
        recipe: DOCUMENT_TEXT_RECIPE,
        extraction: (index === 0 ? 'c' : 'd').repeat(64),
        complete: coverage === 'complete',
        text,
      })),
    } satisfies DocumentTextProjection,
  };
  return { partition, position: 9n, subjects: [subject] };
}

function indexedSubject(snapshot: SubjectSnapshot) {
  const [action] = documentActions(snapshot, [subjectId]);
  if (!action || action.op !== 'index') throw new Error('Expected an indexed subject');
  return action.document;
}

describe('subject document text index projection', () => {
  it('keeps document boundaries and actual languages in separate nested values', () => {
    const value = indexedSubject(indexed('complete', ['a phrase in English', 'un mot en français']));

    expect(value.document_text_coverage).toBe('complete');
    expect(value.document_texts?.map(({ text, language }) => [text, language])).toEqual([
      ['a phrase in English', 'en'],
      ['un mot en français', 'fr'],
    ]);
  });

  it('retains incomplete and unavailable coverage without inventing document text', () => {
    for (const coverage of ['partial', 'unsupported', 'preparing', 'unavailable'] as const) {
      const value = indexedSubject(indexed(coverage, []));
      expect(value.document_text_coverage).toBe(coverage);
      expect(value.document_texts).toBeUndefined();
    }
  });

  it('rejects a projection bound to a different Subject identity', () => {
    const snapshot = indexed('complete', ['text']);
    const subject = snapshot.subjects[0]!;
    subject.documentText = {
      ...subject.documentText!,
      selection: { ...subject.documentText!.selection, subject: '00000000-0000-7000-8000-000000000099' },
    };
    expect(() => documentActions(snapshot, [subjectId])).toThrow('not bound to the indexed subject');
  });

  it('rejects retained text beyond the per-Subject byte ceiling', () => {
    expect(() => documentActions(indexed('partial', ['x'.repeat(64 * 1024 + 1)]), [subjectId])).toThrow(
      'exceeds its retained bounds',
    );
  });
});
