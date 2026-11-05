import { expect, test } from 'bun:test';
import type { SlotLifetime } from '../src/library/subject-library-current-origin';
import type { SubjectReference } from '../src/library/subject-ref';
import {
  captureEntryRemovalReview,
  entryRemovalReviewMatches,
} from '../src/library/subject-entry-removal-review/review';

const subject = {
  id: 'subject-1',
  type: 'novel',
  label: 'The Long Title',
  typeLabel: 'Novel',
} satisfies SubjectReference;
function createLifetime(
  seed: string,
  deleteAdmitted: () => boolean = () => true,
  active: () => boolean = () => true,
): SlotLifetime {
  return {
    seed,
    active: true,
    current: (...operations) =>
      active() &&
      operations.every(
        (operation) =>
          operation === 'library_entry.get' || (operation === 'library_entry.delete' && deleteAdmitted()),
      ),
  };
}

test('removal review retains the exact Entry, admits delete without put, and rejects retired origins', () => {
  let deleteAdmitted = true;
  let active = true;
  const lifetime = createLifetime('subject-origin', () => deleteAdmitted, () => active);
  const entry = {
    subjectId: subject.id,
    state: 'planned',
    revision: 14,
    incarnationId: 'incarnation-a',
  };
  const review = captureEntryRemovalReview({
    subject,
    entry,
    stateLabel: 'Planned',
    originKey: 'subject-origin:read-a:en',
    lifetime,
  });
  if (!review) throw new Error('expected the admitted Entry to produce a review');

  expect(review.basis).toEqual({
    subjectId: subject.id,
    state: 'planned',
    revision: 14,
    incarnationId: 'incarnation-a',
  });
  expect(review).not.toHaveProperty('idempotencyKey');
  expect(lifetime.current('library_entry.get')).toBe(true);
  expect(lifetime.current('library_entry.get', 'library_entry.delete')).toBe(true);
  expect(
    entryRemovalReviewMatches(review, {
      subject,
      entry,
      originKey: 'subject-origin:read-a:en',
      lifetime,
    }),
  ).toBe(true);
  expect(
    entryRemovalReviewMatches(review, {
      subject,
      entry: { ...entry, incarnationId: 'incarnation-b' },
      originKey: 'subject-origin:read-a:en',
      lifetime,
    }),
  ).toBe(false);
  expect(
    entryRemovalReviewMatches(review, {
      subject,
      entry,
      originKey: 'subject-origin:read-b:en',
      lifetime,
    }),
  ).toBe(false);
  expect(
    entryRemovalReviewMatches(review, {
      subject,
      entry: { ...entry, revision: 15 },
      originKey: 'subject-origin:read-a:en',
      lifetime,
    }),
  ).toBe(false);
  const reopened = captureEntryRemovalReview({
    subject,
    entry,
    stateLabel: 'Planned',
    originKey: 'subject-origin:read-a:en',
    lifetime,
  });
  expect(reopened).not.toBe(review);
  expect(reopened?.basis).toEqual(review.basis);

  deleteAdmitted = false;
  expect(lifetime.current('library_entry.get')).toBe(true);
  expect(
    entryRemovalReviewMatches(review, {
      subject,
      entry,
      originKey: 'subject-origin:read-a:en',
      lifetime,
    }),
  ).toBe(false);
  deleteAdmitted = true;
  active = false;
  expect(
    entryRemovalReviewMatches(review, {
      subject,
      entry,
      originKey: 'subject-origin:read-a:en',
      lifetime: createLifetime('subject-origin'),
    }),
  ).toBe(false);
});
