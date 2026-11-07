import { QUESTION } from '../../features/pages/subject-ratings';
import type { CollectionViewerFacts, CollectionMember } from '../reads';

type CurrentViewerFacts = Extract<CollectionViewerFacts, { state: 'current' }>;
export type CollectionViewerFact = CurrentViewerFacts['rows'][number];
export type CollectionViewerQuestion = CurrentViewerFacts['question'];

export type CollectionViewerMember = Pick<CollectionMember, 'subjectId' | 'subject'> & {
  id?: string;
  viewerRowKey?: string;
};

export type CollectionViewerProjection =
  | { state: 'withheld' }
  | { state: 'unavailable' }
  | {
      state: 'current';
      question: CollectionViewerQuestion;
      rows: readonly CollectionViewerFact[];
    };

/** A private page is usable only for the exact browser reader and live route admission that requested it. */
export function collectionViewerProjection(
  facts: CollectionViewerFacts | undefined,
  provenance: { mode: 'anonymous' | 'session'; viewerId: string | null } | undefined,
  viewerId: string | null,
  current: boolean,
): CollectionViewerProjection {
  if (!current || !viewerId || provenance?.mode !== 'session' || provenance.viewerId !== viewerId)
    return { state: 'withheld' };
  if (!facts || facts.state !== 'current') return { state: 'unavailable' };
  return { state: 'current', question: facts.question, rows: facts.rows };
}

/** Match native facts by occurrence row key and its original admitted subject identity. */
export function collectionViewerFactForMember(
  projection: CollectionViewerProjection,
  member: CollectionViewerMember,
): CollectionViewerFact | undefined {
  if (projection.state !== 'current' || !member.subject || !member.subjectId) return undefined;
  const rowKey = member.viewerRowKey ?? member.id;
  if (!rowKey) return undefined;
  const matches = projection.rows.filter((row) => row.rowKey === rowKey && row.subjectId === member.subjectId);
  return matches.length === 1 ? matches[0] : undefined;
}

export function collectionViewerVoteCurrent(row: CollectionViewerFact, question: CollectionViewerQuestion): boolean {
  return (
    question !== null &&
    question.id === QUESTION &&
    question.revision === 1 &&
    question.scale.min === 0 &&
    question.scale.max === 20 &&
    question.scale.displayStep === 1 &&
    question.meaning.trim().length > 0 &&
    row.vote.state !== 'unavailable' &&
    row.vote.questionId === question.id &&
    row.vote.questionRevision === question.revision
  );
}

/** The installed members.get row has no actions field. Facts never imply a grant.
 * Keep controls unavailable until the producer publishes its typed occurrence/account-bound closure.
 */
export function collectionViewerActionsState(_row: CollectionViewerFact | undefined): 'current' | 'unavailable' {
  return 'unavailable';
}

/** The original Subject hosts remain the only Entry/progress/vote writers. */
export function collectionViewerHasPersonalAction(
  _row: CollectionViewerFact | undefined,
  _question: CollectionViewerQuestion,
): boolean {
  return false;
}

export { collectionMemberReturnAddress, collectionViewerActionHref } from '../../subject/collection-return';
