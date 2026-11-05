import { expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { createSubjectTextRetryController } from '../src/subject/reading-state';
import { statementDocument } from '../src/features/pages/documents';
import {
  SUMMARY_CHOICE_ENTRY_CAP,
  SUMMARY_CHOICE_METADATA_BYTE_CAP,
  synopsisChoices,
  synopsisReturnMatches,
} from '../src/features/pages/subject-summary-reading/model';
import {
  summaryReadingFragment,
  summaryReadingReturn,
  subjectVisitReturn,
} from '../src/features/pages/subject-visit-navigation';
import type { Subject } from '../src/subject/types';

const subjectId = '00000000-0000-4000-8000-000000000001';
const digest = 'a'.repeat(64);

function candidate(id: string, language: string, rank = 'preferred', note = 'https://evidence.test/source') {
  return {
    id,
    rank,
    property: { id: 'schema:abstract', data_type: 'document' },
    value: { type: 'value', content: { document: `doc-${id}`, digest, language } },
    qualifiers: [],
    references: [
      { parts: [{ property: { id: 'schema:url', data_type: 'url' }, value: { type: 'value', content: note } }] },
    ],
  };
}

function subject(statements: unknown[], type = 'schema:Book') {
  return {
    id: subjectId,
    type,
    context: '00000000-0000-4000-8000-000000000002',
    statements: { 'schema:abstract': statements },
    descriptions: {},
  } as unknown as Subject;
}

function filled(entries: ReturnType<typeof candidate>[]) {
  return Object.fromEntries(
    entries.map((entry) => [
      entry.id,
      {
        id: entry.value.content.document,
        subjectId,
        candidateId: entry.id,
        digest,
        language: entry.value.content.language,
        availability: 'available',
        body: fromPlainText(entry.id),
      },
    ]),
  );
}

test('work choices preserve native rank, supplied languages, exact same-language identities and document binding', () => {
  const enFirst = candidate('candidate-en-1', 'en');
  const enSecond = candidate('candidate-en-2', 'en', 'preferred', 'https://evidence.test/second');
  const ja = candidate('candidate-ja', 'ja');
  const normal = candidate('candidate-normal', 'de', 'normal');
  const set = synopsisChoices(subject([enFirst, enSecond, ja, normal]), 'en');
  expect(set.kind).toBe('ready');
  if (set.kind !== 'ready') return;
  expect(set.choices.map(({ statement }) => statement.id)).toEqual([
    'candidate-en-1',
    'candidate-en-2',
    'candidate-ja',
  ]);
  expect(set.selectedId).toBe('candidate-en-1');
  expect(synopsisChoices(subject([enFirst, enSecond, ja]), 'ja').kind).toBe('ready');
  const japanese = synopsisChoices(subject([enFirst, enSecond, ja]), 'ja');
  expect(japanese.kind === 'ready' && japanese.selectedId).toBe('candidate-ja');
  expect(statementDocument(subjectId, enFirst, filled([enFirst]))).toBeDefined();
  expect(statementDocument(subjectId, enSecond, filled([enSecond]))).toBeDefined();
  expect(statementDocument(subjectId, enSecond, { [enSecond.id]: filled([enFirst])[enFirst.id] })).toBeUndefined();
  expect(
    synopsisReturnMatches(set.choices[1], {
      candidateId: enSecond.id,
      documentId: enSecond.value.content.document,
      digest,
      language: 'en',
    }),
  ).toBe(true);
  expect(
    synopsisReturnMatches(set.choices[0], {
      candidateId: enSecond.id,
      documentId: enSecond.value.content.document,
      digest,
      language: 'en',
    }),
  ).toBe(false);
});

test('choice admission refuses a partial oversized projection and non-work types stay with their owner', () => {
  const oversized = candidate(
    'candidate-large',
    'en',
    'preferred',
    `https://evidence.test/${'x'.repeat(SUMMARY_CHOICE_METADATA_BYTE_CAP)}`,
  );
  expect(synopsisChoices(subject([oversized]), 'en')).toEqual({ kind: 'unavailable', reason: 'too-large' });
  const tooMany = Array.from({ length: SUMMARY_CHOICE_ENTRY_CAP + 1 }, (_, index) =>
    candidate(`candidate-${index}`, 'en'),
  );
  expect(synopsisChoices(subject(tooMany), 'en')).toEqual({ kind: 'unavailable', reason: 'too-many' });
  expect(synopsisChoices(subject([candidate('candidate-person', 'en')], 'schema:Person'), 'en')).toEqual({
    kind: 'not-admitted',
  });
});

test('a retired A-B-A retry target never becomes current again and a return address is bounded and exact', () => {
  const retry = createSubjectTextRetryController<{ candidate: string }>();
  const a1 = { candidate: 'a' };
  const b = { candidate: 'b' };
  const a2 = { candidate: 'a' };
  retry.select(a1);
  const old = retry.begin(a1)!;
  retry.select(b);
  retry.select(a2);
  expect(retry.isCurrent(old)).toBe(false);
  const current = retry.begin(a2);
  expect(current).toBeNull(); // the retired transport still occupies the one in-flight slot
  retry.finish(old);
  const next = retry.begin(a2)!;
  expect(retry.isCurrent(next)).toBe(true);

  const fragment = summaryReadingFragment({
    candidateId: 'candidate-a',
    documentId: 'doc-a',
    digest,
    language: 'zh-Hant',
    locale: 'en',
    context: 'context-a',
    release: 'release-a',
    expanded: true,
    focus: 'evidence',
  })!;
  const descriptor = summaryReadingReturn(fragment)!;
  expect(descriptor).toMatchObject({ candidateId: 'candidate-a', language: 'zh-Hant', locale: 'en', expanded: true });
  expect(subjectVisitReturn(`/en/subjects/${subjectId}/a?via=ignored${fragment}`, 'en')).toBeUndefined();
  expect(subjectVisitReturn(`/en/subjects/${subjectId}/a${fragment}`, 'en')).toBe(
    `/en/subjects/${subjectId}/a${fragment}`,
  );
});
