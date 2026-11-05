import { expect, mock, test } from 'bun:test';
import { documentText, fromMarkdown } from '@rezics/document';
import { renderToStaticMarkup } from 'react-dom/server';
import { statementDocument } from '../src/features/pages/documents';

mock.module('../src/paraglide/messages.js', () => ({
  m: { subject_section_failed: () => 'Text unavailable', subject_section_retry: () => 'Retry text' },
}));
const { createSubjectTextRetryController, SubjectReadingState } = await import('../src/subject/reading-state');

test('a successful empty public document remains distinct from a failed read', () => {
  const statement = {
    id: '0494501a-36af-8cc7-95c9-d7ffe4728201',
    value: { type: 'value', content: { language: 'en', document: 'public-document', digest: 'a'.repeat(64) } },
  };
  const filled = {
    [statement.id]: {
      id: 'public-document',
      subjectId: 'public-subject',
      candidateId: statement.id,
      digest: 'a'.repeat(64),
      language: 'en',
      availability: 'available',
      body: fromMarkdown(''),
    },
  };

  const empty = statementDocument('public-subject', statement, filled);
  expect(empty).toBeDefined();
  expect(documentText(empty!)).toBe('');
  expect(statementDocument('public-subject', statement, undefined)).toBeUndefined();
});

test('retry allows one read per visit and rejects a late result after the visit changes', () => {
  const retry = createSubjectTextRetryController<{ visit: number }>();
  const firstVisit = { visit: 1 };
  const nextVisit = { visit: 2 };
  retry.select(firstVisit);
  const first = retry.begin(firstVisit)!;
  expect(first.signal.aborted).toBe(false);
  expect(retry.begin(firstVisit)).toBeNull();
  retry.select(nextVisit);
  retry.retire(firstVisit);
  expect(first.signal.aborted).toBe(true);
  const next = retry.begin(nextVisit)!;
  expect(next.signal).not.toBe(first.signal);
  expect(retry.isCurrent(first)).toBe(false);
  expect(retry.isCurrent(next)).toBe(true);
  retry.finish(first);
  expect(retry.isCurrent(next)).toBe(true);
  retry.retire(nextVisit);
  expect(next.signal.aborted).toBe(true);
});

test('failed text keeps a real document navigation fallback', () => {
  const markup = renderToStaticMarkup(<SubjectReadingState locale="en" href="/en/subjects/example/details" />);
  expect(markup).toContain('href="/en/subjects/example/details"');
});
