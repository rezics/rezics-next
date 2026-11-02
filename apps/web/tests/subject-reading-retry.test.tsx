import { expect, mock, test } from 'bun:test';
import { fromMarkdown } from '@rezics/document';
import { renderToStaticMarkup } from 'react-dom/server';
import { createSubjectTextRetryController, SubjectReadingState } from '../src/subject/reading-state';
import type { Subject } from '../src/subject/types';
import type { Stmt } from '../src/features/pages/shared';
import subjectRecording from '../src/kernel/recorded/subject.json';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { chosenSummary } = await import('../src/features/pages/overview');

test('a successful empty public document remains distinct from a failed read', () => {
  const subject = structuredClone(subjectRecording.subject) as Subject;
  const statement = {
    id: '0494501a-36af-8cc7-95c9-d7ffe4728201',
    rank: 'normal',
    property: { id: 'schema:abstract', data_type: 'document' },
    value: { type: 'value', content: { language: 'en', document: 'public-document', digest: 'a'.repeat(64) } },
    qualifiers: [],
    references: [],
  } as unknown as Stmt;
  subject.statements = { 'schema:abstract': [statement] } as Subject['statements'];
  const filled = {
    [statement.id!]: {
      id: 'public-document',
      subjectId: subject.id,
      candidateId: statement.id,
      digest: 'a'.repeat(64),
      language: 'en',
      availability: 'available',
      body: fromMarkdown(''),
    },
  };

  expect(chosenSummary(subject, 'en', filled)?.document).toEqual(fromMarkdown(''));
  expect(chosenSummary(subject, 'en')).toBeUndefined();
});

test('retry allows one read per visit and rejects a late result after the visit changes', () => {
  const retry = createSubjectTextRetryController<{ visit: number }>();
  const firstVisit = { visit: 1 };
  const nextVisit = { visit: 2 };
  retry.select(firstVisit);
  const first = retry.begin(firstVisit)!;
  expect(retry.begin(firstVisit)).toBeNull();
  retry.select(nextVisit);
  const next = retry.begin(nextVisit)!;
  expect(retry.isCurrent(first)).toBe(false);
  expect(retry.isCurrent(next)).toBe(true);
  retry.finish(first);
  expect(retry.isCurrent(next)).toBe(true);
});

test('failed text keeps a real document navigation fallback', () => {
  const markup = renderToStaticMarkup(
    <SubjectReadingState locale="en" href="/en/subjects/example/details" />,
  );
  expect(markup).toContain('href="/en/subjects/example/details"');
});
