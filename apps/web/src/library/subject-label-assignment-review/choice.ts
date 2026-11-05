import { normalizeLibraryLabelName } from '../subject-label-name';
import type { LibraryLabelSummary, SubjectLabel } from '../subject-labels.ts';

export type SubjectLabelReviewChoice =
  | { kind: 'existing'; label: LibraryLabelSummary; rawName: string }
  | { kind: 'proposed'; name: string };

export type SubjectLabelReviewOrigin = {
  subjectId: string;
  locale: string;
  lifetimeSeed: string;
  query: string;
  pickerSequence: number;
  optionRevision: number;
  optionsKey: string;
  assignmentsKey: string;
};

export type SubjectLabelReviewTrigger =
  | { kind: 'input' }
  | { kind: 'submit' }
  | { kind: 'existing'; id: string }
  | { kind: 'proposed' };

export type SubjectLabelReview = {
  choice: SubjectLabelReviewChoice;
  origin: SubjectLabelReviewOrigin;
  trigger: SubjectLabelReviewTrigger;
};

export type SubjectLabelReviewAssignment = Pick<SubjectLabel, 'id' | 'labelId' | 'name' | 'revision'>;

/** Preserve the exact supplied identity when the existing picker already resolves this normalized name. */
export function resolveSubjectLabelReviewChoice(
  rawName: string,
  options: readonly LibraryLabelSummary[],
): SubjectLabelReviewChoice | undefined {
  const normalizedName = normalizeLibraryLabelName(rawName);
  if (!normalizedName) return undefined;
  const existing = options.find((option) => normalizeLibraryLabelName(option.name) === normalizedName);
  return existing
    ? { kind: 'existing', label: { ...existing }, rawName }
    : { kind: 'proposed', name: rawName };
}

export function selectSubjectLabelReviewChoice(
  option: LibraryLabelSummary,
  options: readonly LibraryLabelSummary[],
  rawName: string,
): SubjectLabelReviewChoice | undefined {
  const supplied = options.find(
    (candidate) => candidate.id === option.id && candidate.name === option.name && candidate.revision === option.revision,
  );
  return supplied ? { kind: 'existing', label: { ...supplied }, rawName } : undefined;
}

export function subjectLabelOptionsKey(options: readonly LibraryLabelSummary[]): string {
  return JSON.stringify(options.map(({ id, name, revision }) => [id, name, revision]));
}

export function subjectLabelAssignmentsKey(assignments: readonly SubjectLabelReviewAssignment[]): string {
  return JSON.stringify(assignments.map(({ id, labelId, name, revision }) => [id, labelId, name, revision]));
}

export function subjectLabelReviewIsCurrent(review: SubjectLabelReview, current: SubjectLabelReviewOrigin): boolean {
  const origin = review.origin;
  return (
    origin.subjectId === current.subjectId &&
    origin.locale === current.locale &&
    origin.lifetimeSeed === current.lifetimeSeed &&
    origin.query === current.query &&
    origin.pickerSequence === current.pickerSequence &&
    origin.optionRevision === current.optionRevision &&
    origin.optionsKey === current.optionsKey &&
    origin.assignmentsKey === current.assignmentsKey
  );
}

export function subjectLabelReviewAlreadyAssigned(
  review: SubjectLabelReview,
  assignments: readonly SubjectLabelReviewAssignment[],
): boolean {
  if (review.choice.kind !== 'existing') return false;
  const labelId = review.choice.label.id;
  return assignments.some((assignment) => assignment.labelId === labelId);
}
