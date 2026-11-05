import { useState } from 'react';
import { m } from '../../../paraglide/messages.js';
import { draftFetch, PostComposer } from '../../../threads/composer';
import { replyToThread } from '../../../threads/actions';
import type { ReplyCommand } from '../../../threads/reply-context-intent';
import type { CreatedPost } from '../../../threads/actions';
import type { OperationLease } from '../../../reader/lease';
import { contributionOperationLeaseId, type ContributionOperation } from './current';
import {
  contributionCommandTarget,
  contributionOperationAdvice,
  originalContributionReference,
  type ContributionAdviceState,
} from './advice';
import type { ContributionReference } from './receiver';
import { ContributionAdvicePresentation, type ContributionPresentation } from './presentation';

function isReplyLease(lease: OperationLease<ContributionOperation> | undefined): lease is OperationLease<'reply'> {
  return lease?.operation === 'reply';
}

export type ContributionReplyTarget = {
  reference: ContributionReference;
  threadId: string;
  threadRevisionId: string | null;
  boardId: string;
  parentId: string;
};

const contentId = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Keep replies attached to the selected native thread and immediate original post. */
export function contributionReplyTarget(
  input: ContributionPresentation['input'],
  row: Record<string, unknown>,
): ContributionReplyTarget | undefined {
  const reference = originalContributionReference(input, row);
  if (!reference) return;
  const firstPost = row.firstPost;
  const parentId =
    reference.type === 'content.post'
      ? reference.id
      : record(firstPost) && firstPost.threadId === reference.id
        ? firstPost.id
        : undefined;
  if (!contentId(parentId)) return;
  const thread = contributionCommandTarget(reference, 'reply');
  return {
    reference,
    threadId: thread.id,
    threadRevisionId: thread.revisionId,
    boardId: reference.placeId,
    parentId,
  };
}

/** Compose the native post.create owner without borrowing a row or another page's intent. */
export function ContributionReply({
  presentation,
  canonicalHref,
  refreshAdvice,
}: {
  presentation: ContributionPresentation;
  /** The exact original row destination shown beside the reply composer. */
  canonicalHref: string;
  refreshAdvice?: (() => Promise<void>) | undefined;
}) {
  const { input, row, source, reader, isCurrent } = presentation;
  const target = contributionReplyTarget(input, row);
  const advice: ContributionAdviceState = !isCurrent()
    ? 'retired'
    : presentation.failed
      ? 'failed'
      : target
        ? contributionOperationAdvice({
            reference: target.reference,
            operation: 'reply',
            action: 'post:create',
            operationId: 'post.create',
            source,
            reader,
            isCurrent,
          })
        : 'unavailable';
  const candidateLease = target && isCurrent() ? presentation.operation('reply') : undefined;
  const lease = isReplyLease(candidateLease) ? candidateLease : undefined;
  const ready =
    advice === 'available' &&
    !!reader &&
    lease?.reader === reader &&
    lease.current() &&
    lease.credential() !== null;
  const state = advice === 'available' && !ready ? 'unavailable' : advice;
  const ownerKey = JSON.stringify([
    contributionOperationLeaseId(lease),
    input.accountId,
    input.view,
    input.cursor,
    input.proof,
    target?.threadId,
    target?.threadRevisionId,
    target?.parentId,
    target?.reference.type,
    target?.reference.id,
    target?.reference.sourceRevisionId,
  ]);

  return (
    <ContributionReplyVisit
      key={ownerKey}
      presentation={presentation}
      state={state}
      target={target}
      lease={lease}
      ready={ready}
      canonicalHref={canonicalHref}
      refreshAdvice={refreshAdvice}
    />
  );
}

type ReplyOrigin = {
  threadId: string;
  threadRevisionId: string | null;
  boardId: string;
  parentId: string;
  sourceType: ContributionReference['type'];
  sourceId: string;
  sourceRevisionId: string | null;
  operationLease: number;
};

function ContributionReplyVisit({
  presentation,
  state,
  target,
  lease,
  ready,
  canonicalHref,
  refreshAdvice,
}: {
  presentation: ContributionPresentation;
  state: ContributionAdviceState;
  target: ContributionReplyTarget | undefined;
  lease: OperationLease<'reply'> | undefined;
  ready: boolean;
  canonicalHref: string;
  refreshAdvice?: (() => Promise<void>) | undefined;
}) {
  const [initialKey] = useState(() => crypto.randomUUID());
  const [pending, setPending] = useState(false);
  const [intentLocked, setIntentLocked] = useState(false);
  const leaseId = contributionOperationLeaseId(lease);
  const currentLease =
    !!target &&
    !!lease &&
    !!leaseId &&
    lease.operation === 'reply' &&
    lease.reader === presentation.reader &&
    presentation.isCurrent() &&
    lease.current();
  const keepOwner = currentLease && (ready || pending || intentLocked) && state !== 'retired';
  const origin: ReplyOrigin | undefined =
    target && leaseId !== null
      ? {
          threadId: target.threadId,
          threadRevisionId: target.threadRevisionId,
          boardId: target.boardId,
          parentId: target.parentId,
          sourceType: target.reference.type,
          sourceId: target.reference.id,
          sourceRevisionId: target.reference.sourceRevisionId,
          operationLease: leaseId,
        }
      : undefined;

  return (
    <ContributionAdvicePresentation
      state={state}
      label={m.thread_reply_label({}, { locale: presentation.locale })}
      locale={presentation.locale}
      retry={refreshAdvice}
      retainChildren={keepOwner && state !== 'available'}
    >
      {keepOwner && target && lease && origin ? (
        <PostComposer<CreatedPost, ReplyOrigin>
          initialKey={initialKey}
          localDraft={false}
          canSubmit={currentLease}
          containerId={target.threadId}
          boardId={target.boardId}
          replyTargetId={target.parentId}
          submissionContext={origin}
          replyContext={
            <p className="text-sm text-muted-foreground">
              <a href={canonicalHref} className="underline underline-offset-4">
                {m.thread_reply_label({}, { locale: presentation.locale })}
              </a>
            </p>
          }
          onPendingChange={setPending}
          onIntentLockChange={setIntentLocked}
          onSubmit={async (command: ReplyCommand<ReplyOrigin>) => {
            if (
              !currentLease ||
              !presentation.isCurrent() ||
              !lease.current() ||
              command.parentId !== target.parentId ||
              JSON.stringify(command.submissionContext) !== JSON.stringify(origin)
            )
              throw new Error('The original contribution reply is no longer current');
            const credential = lease.credential();
            if (!credential) throw new Error('The original contribution reply is no longer current');
            const result = await replyToThread({
              data: {
                threadId: target.threadId,
                body: command.body,
                idempotencyKey: command.idempotencyKey,
                parentId: target.parentId,
                ...(command.mediaIds.length ? { mediaIds: command.mediaIds } : {}),
              },
              headers: { 'X-CSRF-Token': credential },
              fetch: draftFetch(command.body),
            });
            return result.ok ? { ok: true as const, value: result.post } : result;
          }}
          onSuccess={(_post: CreatedPost) => {
            if (presentation.isCurrent() && lease.current()) void refreshAdvice?.();
          }}
        />
      ) : null}
    </ContributionAdvicePresentation>
  );
}

