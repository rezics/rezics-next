import { libraryLabelNameIssue, type LibraryLabelNameIssue } from './subject-label-name';

/** A transport bound independent of the normalized native scalar limit. */
export const subjectLabelInputLimit = 1000;
export type SubjectLabelInputIssue = LibraryLabelNameIssue | 'transport';

export function subjectLabelInputIssue(value: string, allowEmpty = false): SubjectLabelInputIssue | undefined {
  const issue = libraryLabelNameIssue(value);
  if (issue && !(allowEmpty && issue === 'empty')) return issue;
  if (value.length > subjectLabelInputLimit) return 'transport';
  return undefined;
}
