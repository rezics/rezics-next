import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { subjectLabelInputIssue } from '../src/library/subject-label-input';
import {
  resolveSubjectLabelReviewChoice,
  subjectLabelAssignmentsKey,
  subjectLabelOptionsKey,
  subjectLabelReviewAlreadyAssigned,
  subjectLabelReviewIsCurrent,
  type SubjectLabelReview,
  type SubjectLabelReviewOrigin,
} from '../src/library/subject-label-assignment-review/choice';
import { SubjectLabelAssignmentReview } from '../src/library/subject-label-assignment-review/review-panel';

const option = { id: 'catalogue-label-id', name: 'Café reads', revision: 7 };
const subjectName = 'A long localized Subject title for the review panel';

function origin(options = [option], assignments: { id: string; labelId: string; name: string; revision: number }[] = []) {
  return {
    subjectId: 'subject-id',
    locale: 'en',
    lifetimeSeed: 'label-visit-A',
    query: ' Cafe\u0301   reads ',
    pickerSequence: 4,
    optionRevision: 2,
    optionsKey: subjectLabelOptionsKey(options),
    assignmentsKey: subjectLabelAssignmentsKey(assignments),
  } satisfies SubjectLabelReviewOrigin;
}

test('review resolves only the supplied normalized choice and keeps raw correction input intact', () => {
  const rawName = '  Cafe\u0301   reads  ';
  expect(subjectLabelInputIssue(rawName)).toBeUndefined();
  expect(resolveSubjectLabelReviewChoice(rawName, [option])).toEqual({
    kind: 'existing',
    label: option,
    rawName,
  });
  expect(resolveSubjectLabelReviewChoice('café reads', [option])).toEqual({ kind: 'proposed', name: 'café reads' });
  expect(resolveSubjectLabelReviewChoice(rawName, [])).toEqual({ kind: 'proposed', name: rawName });
  expect(subjectLabelInputIssue('📚'.repeat(101))).toBe('too-long');
  expect(subjectLabelInputIssue('A\u0000B')).toBe('controls');
});

test('review expires when its bounded page, Subject, locale, family visit, or received assignment changes', () => {
  const captured = origin();
  const choice = resolveSubjectLabelReviewChoice('Cafe\u0301 reads', [option])!;
  const review: SubjectLabelReview = {
    choice,
    origin: captured,
    trigger: { kind: 'existing', id: option.id },
  };
  expect(subjectLabelReviewIsCurrent(review, captured)).toBe(true);
  expect(subjectLabelReviewIsCurrent(review, { ...captured, optionRevision: captured.optionRevision + 1 })).toBe(false);
  expect(subjectLabelReviewIsCurrent(review, { ...captured, subjectId: 'another-subject' })).toBe(false);
  expect(subjectLabelReviewIsCurrent(review, { ...captured, locale: 'ja' })).toBe(false);
  expect(subjectLabelReviewIsCurrent(review, { ...captured, lifetimeSeed: 'label-visit-A-again' })).toBe(false);
  expect(
    subjectLabelReviewIsCurrent(
      review,
      origin([option], [{ id: 'assignment-id', labelId: option.id, name: option.name, revision: 3 }]),
    ),
  ).toBe(false);
  expect(
    subjectLabelReviewAlreadyAssigned(review, [
      { id: 'assignment-id', labelId: option.id, name: 'renamed received text', revision: 8 },
    ]),
  ).toBe(true);
  expect(
    subjectLabelReviewAlreadyAssigned(review, [
      { id: 'other-assignment', labelId: 'different-catalogue-id', name: option.name, revision: 1 },
    ]),
  ).toBe(false);
});

test('review markup keeps long names readable, identifies its region, and lays out actions responsively', async () => {
  const longName = 'A very long label name '.repeat(12).trim();
  const review: SubjectLabelReview = {
    choice: { kind: 'proposed', name: longName },
    origin: origin([]),
    trigger: { kind: 'input' },
  };
  const html = renderToStaticMarkup(
    createElement(SubjectLabelAssignmentReview, {
      review,
      subjectName,
      alreadyAssigned: false,
      applyAction: createElement('button', null, 'Apply'),
      onEdit: () => {},
      onDiscard: () => {},
    }),
  );
  expect(html).toContain('role="region"');
  expect(html).toContain('aria-labelledby=');
  expect(html).toContain('sm:grid-cols-[minmax(0,1fr)_auto]');
  expect(html).toContain('break-words');
  expect(html).toContain(longName);
  expect(html).toContain(subjectName);
  expect(html).toContain('data-subject-label-review-apply');
});

test('all eight locale families provide the focused review language', async () => {
  const locales = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'];
  const required = [
    'library_subject_label_review_heading',
    'library_subject_label_review_subject',
    'library_subject_label_review_existing',
    'library_subject_label_review_proposed',
    'library_subject_label_review_proposal_note',
    'library_subject_label_review_apply',
    'library_subject_label_review_edit',
    'library_subject_label_review_discard',
    'library_subject_label_review_already_assigned',
    'library_subject_label_review_stale',
  ];
  for (const locale of locales) {
    const messages = (await Bun.file(new URL(`../messages/${locale}.json`, import.meta.url)).json()) as Record<
      string,
      string
    >;
    for (const key of required) expect(messages[key]?.trim()).toBeTruthy();
  }
});
