import type { DocumentSnapshot } from '@rezics/document';
import { replyToThread, type CreatedPost } from '../actions';
import { draftFetch, PostComposer } from '../composer';
import type { ReplyCommand } from '../reply-context-intent';
import { ThreadReactions, type ThreadReactionsProps } from '../thread-reactions';
import { ThreadWatch } from '../thread-watch';
import type { ThreadWatchNative } from '../thread-watch-native';
import type {
  ContributionReactionMount,
  ContributionReplyMount,
  ContributionWatchMount,
  ThreadContributionActions,
} from '../contract/contribution-actions';

/** Existing watch engine, bound for the profile action host. */
export function ThreadWatchAdapter(props: ContributionWatchMount) {
  return (
    <ThreadWatch
      threadId={props.threadId}
      session={props.session}
      sessionKnown={props.sessionKnown}
      viewerId={props.viewerId}
      sessionStamp={props.sessionStamp}
      admitted={props.admitted}
      canStart={props.canStart}
      allowDiscard={props.allowDiscard}
      initialWatching={props.initialWatching}
      returnTo={props.returnTo}
      readAuthority={props.readAuthority}
      isCurrent={props.isCurrent}
      {...(props.refreshAdvice ? { refreshAdvice: props.refreshAdvice } : {})}
      {...(props.native ? { native: props.native as ThreadWatchNative } : {})}
    />
  );
}

/** Existing reaction engine, bound for the profile action host. */
export function ThreadReactionAdapter({
  sourceWatermark,
  onDiscard,
  onMutation,
  preparedTransport,
  ...required
}: ContributionReactionMount) {
  return (
    <ThreadReactions
      {...required}
      {...(sourceWatermark ? { sourceWatermark } : {})}
      {...(onDiscard ? { onDiscard } : {})}
      {...(onMutation ? { onMutation } : {})}
      {...(preparedTransport
        ? { preparedTransport: preparedTransport as NonNullable<ThreadReactionsProps['preparedTransport']> }
        : {})}
    />
  );
}

/** Existing reply composer and native post.create owner. */
export function ThreadReplyAdapter<Context>(props: ContributionReplyMount<Context>) {
  return (
    <PostComposer<CreatedPost, Context>
      initialKey={props.initialKey}
      localDraft={props.localDraft}
      canSubmit={props.canSubmit}
      canStart={props.canStart}
      containerId={props.containerId}
      boardId={props.boardId}
      replyTargetId={props.replyTargetId}
      submissionContext={props.submissionContext}
      replyContext={props.replyContext}
      onPendingChange={props.onPendingChange}
      onIntentLockChange={props.onIntentLockChange}
      onSubmit={async (command: ReplyCommand<Context>) => {
        if (
          !props.canDispatch(command) ||
          command.parentId !== props.replyTargetId ||
          JSON.stringify(command.submissionContext) !== JSON.stringify(props.submissionContext)
        )
          throw new Error('The original contribution reply is no longer current');
        const credential = props.credential();
        if (!credential) throw new Error('The original contribution reply is no longer current');
        const result = await replyToThread({
          data: {
            threadId: props.containerId,
            body: command.body,
            idempotencyKey: command.idempotencyKey,
            parentId: props.replyTargetId,
            ...(command.mediaIds.length ? { mediaIds: command.mediaIds } : {}),
          },
          headers: { 'X-CSRF-Token': credential },
          fetch: draftFetch(command.body as DocumentSnapshot),
        });
        return result.ok ? { ok: true as const, value: result.post } : result;
      }}
      onSuccess={() => {
        props.onSuccess();
      }}
    />
  );
}

export const threadContributionActions = {
  Watch: ThreadWatchAdapter,
  Reaction: ThreadReactionAdapter,
  Reply: ThreadReplyAdapter,
} as ThreadContributionActions;
