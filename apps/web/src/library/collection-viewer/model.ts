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
  if (!facts || facts.state === 'unavailable') return { state: 'unavailable' };
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

/** Named receiving seam until Commerce's closed member schema is published by Content.
 * Inspect only supplied grants; omission and malformed projections never grant an operation.
 */
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function suppliedActions(row: CollectionViewerFact | undefined): unknown[] | undefined {
  if (!row || !('actions' in row) || !record(row.actions)) return undefined;
  const actions = row.actions;
  if (actions.state !== 'current' || !Array.isArray(actions.allowed)) return undefined;
  if (
    !actions.allowed.every(
      (grant: unknown) =>
        record(grant) &&
        typeof grant.action === 'string' &&
        grant.action.length > 0 &&
        Array.isArray(grant.operations) &&
        grant.operations.every((operation: unknown) => typeof operation === 'string'),
    )
  )
    return undefined;
  return actions.allowed;
}

export function collectionViewerActionsState(row: CollectionViewerFact | undefined): 'current' | 'unavailable' {
  return suppliedActions(row) === undefined ? 'unavailable' : 'current';
}

/** Navigation reaches the existing Subject writers, which independently readmit every command. */
export function collectionViewerHasPersonalAction<Row extends CollectionViewerFact>(
  row: Row | undefined,
  question: CollectionViewerQuestion,
): boolean {
  const actions = suppliedActions(row);
  if (!actions || !row) return false;
  return actions.some((grant) => {
    if (!record(grant) || !Array.isArray(grant.operations)) return false;
    return grant.operations.some((operation: unknown) => {
      switch (grant.action) {
        case 'library_entry:update':
          return row.entry.state !== 'unavailable' && operation === 'library_entry.put';
        case 'library_entry:delete':
          return row.entry.state === 'present' && operation === 'library_entry.delete';
        case 'progress_session:create':
          return row.entry.state === 'present' && operation === 'progress_session.create';
        case 'progress_session:update':
          return (
            row.entry.state === 'present' &&
            [
              'progress_session.record',
              'progress_session.record_episodes',
              'progress_session.complete',
              'progress_session.abandon',
              'progress_session.reopen',
              'progress_session.retire',
              'progress_session_journal.update',
            ].includes(String(operation))
          );
        case 'rating:vote':
          return (
            collectionViewerVoteCurrent(row, question) &&
            (operation === 'rating.vote_put' || operation === 'rating.vote_delete')
          );
        default:
          return false;
      }
    });
  });
}

const localOrigin = 'https://rezics.invalid';
const locales = '(?:en|zh-Hant|zh-Hans|ja|ko|fr|de|es)';
const collectionPath = new RegExp(`^/${locales}/collections/[0-9a-f-]{36}$`, 'i');

/** Build the safe Collection visit return with the source address and exact occurrence fragment intact. */
export function collectionMemberReturnAddress(currentHref: string, memberId?: string): string | undefined {
  if (
    !currentHref.startsWith('/') ||
    currentHref.startsWith('//') ||
    (memberId !== undefined && !/^[0-9a-f-]{36}$/i.test(memberId)) ||
    currentHref.length > 16_384
  )
    return undefined;
  try {
    const current = new URL(currentHref, localOrigin);
    if (current.origin !== localOrigin || !collectionPath.test(current.pathname)) return undefined;
    const params = new URLSearchParams();
    const seen = new Set<string>();
    let filters = 0;
    for (const [key, value] of current.searchParams) {
      if (key === 'cursor' || key === 'layout' || key === 'type') {
        if (seen.has(key)) return undefined;
        seen.add(key);
        if (key === 'cursor' && value.length > 4096) return undefined;
        if (key === 'layout' && value !== 'list' && value !== 'grid') return undefined;
        if (key === 'type' && value.length > 128) return undefined;
        params.append(key, value);
      } else if (/^[frl]\.[a-zA-Z0-9:_.-]{1,128}$/.test(key) && value.length <= 256 && filters < 100) {
        params.append(key, value);
        filters += 1;
      }
    }
    current.search = params.toString();
    current.hash = memberId ? `collection-member-${memberId}` : '';
    return `${current.pathname}${current.search}${current.hash}`;
  } catch {
    return undefined;
  }
}

export function collectionViewerActionHref(subjectHref: string, returnTo: string | undefined): string | undefined {
  if (!returnTo) return undefined;
  try {
    const target = new URL(subjectHref, localOrigin);
    if (target.origin !== localOrigin || !target.pathname.startsWith('/')) return undefined;
    target.searchParams.set('via', returnTo);
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return undefined;
  }
}
