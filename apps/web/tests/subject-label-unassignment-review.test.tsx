import { expect, test } from 'bun:test';
import {
  captureSubjectLabelReview,
  subjectLabelReviewIsCurrent,
} from '../src/library/subject-label-unassignment-review/review';
import type { SlotLifetime } from '../src/library/subject-library-current-origin';
import type { SubjectLabel } from '../src/library/subject-labels.ts';
import type { SubjectReference } from '../src/library/subject-ref';

const subject: SubjectReference = {
  id: 'subject-a',
  type: 'schema:Book',
  label: 'The long received Subject title',
};
const assignment: SubjectLabel = {
  id: 'assignment-a',
  labelId: 'label-a',
  name: 'The supplied Label name',
  revision: 8,
};
const admitted = new Set(['library_label.assignment_list', 'library_label.unassign']);
const lifetime = (seed: string, gates = admitted): SlotLifetime => ({
  seed,
  active: true,
  current: (...operations) => operations.every((operation) => gates.has(operation)),
});

test('review evidence uses the exact received Subject assignment tuple while names stay presentation only', () => {
  const origin = 'subject-a:en:read-a';
  const source = lifetime('A');
  const review = captureSubjectLabelReview(subject, 'en', assignment, origin, source);
  expect(review).toMatchObject({
    subjectId: subject.id,
    assignmentId: assignment.id,
    labelId: assignment.labelId,
    revision: assignment.revision,
    labelName: assignment.name,
    subjectLabel: subject.label,
    locale: 'en',
    originKey: origin,
  });
  expect(
    subjectLabelReviewIsCurrent(review, {
      subject,
      locale: 'en',
      assignments: [{ ...assignment, name: 'A newer display name' }],
      originKey: origin,
      lifetime: source,
    }),
  ).toBe(true);
  for (const replacement of [
    { ...assignment, id: 'replacement-assignment' },
    { ...assignment, labelId: 'replacement-label' },
    { ...assignment, revision: assignment.revision + 1 },
  ])
    expect(
      subjectLabelReviewIsCurrent(review, {
        subject,
        locale: 'en',
        assignments: [replacement],
        originKey: origin,
        lifetime: source,
      }),
    ).toBe(false);
});

test('retired reads and missing unassign admission close review without closing the received Label list', () => {
  const origin = 'subject-a:en:read-a';
  const source = lifetime('A');
  const review = captureSubjectLabelReview(subject, 'en', assignment, origin, source);
  expect(source.current('library_label.assignment_list')).toBe(true);
  expect(
    subjectLabelReviewIsCurrent(review, {
      subject,
      locale: 'en',
      assignments: [assignment],
      originKey: origin,
      lifetime: lifetime('A'),
    }),
  ).toBe(false);

  const readOnly = lifetime('A', new Set(['library_label.assignment_list', 'library_label.assign']));
  expect(readOnly.current('library_label.assignment_list')).toBe(true);
  expect(readOnly.current('library_label.unassign')).toBe(false);
  expect(
    subjectLabelReviewIsCurrent(review, {
      subject,
      locale: 'en',
      assignments: [assignment],
      originKey: origin,
      lifetime: readOnly,
    }),
  ).toBe(false);
  expect(
    subjectLabelReviewIsCurrent(review, {
      subject,
      locale: 'en',
      assignments: [assignment],
      originKey: 'subject-a:en:read-b',
      lifetime: source,
    }),
  ).toBe(false);
});
