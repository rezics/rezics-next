import type { ContributionActionsInput, ContributionReference } from './receiver';
import type { AuthorContributionActionsResponse } from './wire';
import type { ContributionOperation } from './current';

/** The installed callable's viewer and action advice; the selector reads nothing else from a response. */
export type NativeContributionAdvice = Pick<AuthorContributionActionsResponse, 'viewer' | 'actions'> & {
  currentness: Pick<AuthorContributionActionsResponse['currentness'], 'actions'>;
};

export type ContributionAdviceState =
  | 'available'
  | 'denied'
  | 'sign_in_required'
  | 'withheld'
  | 'unavailable'
  | 'not_applicable'
  | 'missing'
  | 'retired'
  | 'failed';

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const visible = (value: Record<string, unknown>) =>
  value.availability === 'available' && (value.visibility === 'published' || value.visibility === 'protected');

/** Only a surviving original occurrence can use advice; rows never manufacture the selected read input. */
export function originalContributionReference(
  input: ContributionActionsInput,
  row: Record<string, unknown>,
): ContributionReference | undefined {
  if (!visible(row) || row.authorId !== input.accountId) return;
  const candidates = input.references.filter((reference) => reference.id === row.id);
  if (candidates.length !== 1) return;
  const reference = candidates[0]!;
  if (reference.type === 'content.post') {
    if (
      input.view !== 'posts' ||
      row.threadId !== reference.threadId ||
      row.revisionId !== reference.sourceRevisionId ||
      !record(row.thread) ||
      !visible(row.thread) ||
      row.thread.id !== reference.threadId ||
      row.thread.boardId !== reference.placeId ||
      !record(row.thread.firstPost) ||
      !visible(row.thread.firstPost) ||
      row.thread.firstPost.threadId !== reference.threadId ||
      row.thread.firstPost.revisionId !== reference.threadRevisionId
    )
      return;
  } else if (
    input.view === 'posts' ||
    row.kind !== (input.view === 'reviews' ? 'review' : 'discussion') ||
    row.boardId !== reference.placeId ||
    !record(row.firstPost) ||
    !visible(row.firstPost) ||
    row.firstPost.threadId !== reference.id ||
    row.firstPost.revisionId !== reference.sourceRevisionId
  )
    return;
  return reference;
}

/** Post watch belongs to the containing thread; other commands keep the selected native target. */
export function contributionCommandTarget(reference: ContributionReference, operation: ContributionOperation) {
  if (reference.type === 'content.post' && (operation === 'watch' || operation === 'reply'))
    return { type: 'content.thread' as const, id: reference.threadId, revisionId: reference.threadRevisionId };
  return { type: reference.type, id: reference.id, revisionId: reference.sourceRevisionId };
}

/**
 * Exact advice selection against the installed callable's action advice. It grants no command authority and
 * acknowledges no write from a readback; each command owner still admits its exact operation itself.
 */
export function contributionOperationAdvice({
  reference,
  operation,
  action,
  operationId,
  source,
  reader,
  isCurrent,
  failed = false,
}: {
  reference: ContributionReference;
  operation: ContributionOperation;
  action: string;
  operationId: string;
  source: NativeContributionAdvice | undefined;
  reader: string | null;
  isCurrent: () => boolean;
  failed?: boolean;
}): ContributionAdviceState {
  if (!isCurrent()) return 'retired';
  if (failed) return 'failed';
  if (!source) return 'missing';
  if (source.viewer.kind === 'account' ? source.viewer.id !== reader : reader !== null) return 'unavailable';
  if (source.currentness.actions !== 'current' || source.actions.state !== 'current') return 'unavailable';
  const target = contributionCommandTarget(reference, operation);
  // Null revisions cannot admit private controls against an unspecified original source.
  if (!target.revisionId) return 'unavailable';
  const references = source.actions.references.filter((value) => value.type === target.type && value.id === target.id);
  if (!references.length) return 'missing';
  if (references.length !== 1) return 'unavailable';
  const advice = references[0]!;
  if (advice.state !== 'current') return 'withheld';
  if (advice.sourceRevisionId !== target.revisionId) return 'unavailable';
  const operations = advice.operations.filter((value) => value.action === action && value.operationId === operationId);
  if (!operations.length) return 'missing';
  if (operations.length !== 1) return 'unavailable';
  return operations[0]!.state;
}
