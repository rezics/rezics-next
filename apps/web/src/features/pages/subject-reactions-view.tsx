import type { ReactNode } from 'react';
import { m } from '../../paraglide/messages.js';
import { PostActions } from '../../report/content-actions';
import type { VerificationConfig } from '../../report/turnstile';
import { ThreadReactions } from '../../threads/thread-reactions';
import type { SubjectReactionKind, SubjectReactions } from './subject-reactions';
import { FollowTargetControl } from '../../library/follow-target-control';

/**
 * The reaction cluster and the overflow menu in the subject header's action area, with any other action (the
 * Library controls) beneath. Reporting lives only in the menu. When the counts could not be read the cluster says so
 * in a sentence instead of showing a count that is not known.
 */
export function SubjectHeaderActions({
  id,
  reactions,
  signedIn,
  returnTo,
  verification,
  personalReady = true,
  onPersonalChange,
  reactionOrigin,
  reactionRecovery,
  children,
}: {
  id: string;
  reactions: SubjectReactions | null;
  signedIn: boolean;
  returnTo: string;
  verification: VerificationConfig;
  personalReady?: boolean;
  onPersonalChange?: (kind: SubjectReactionKind | null) => Promise<void>;
  reactionOrigin?: { key: string; reader: string | null; isCurrent(): boolean };
  reactionRecovery?: { failed: boolean; pending: boolean; retry(): void };
  children?: ReactNode;
}) {
  return (
    <>
      <div
        className="flex min-w-0 flex-wrap items-start justify-end gap-2 sm:flex-nowrap sm:col-start-2 sm:row-start-1"
        data-slot="subject-header-actions"
      >
        {reactions ? (
          <div className="min-w-0 flex-1 sm:flex-none">
            <ThreadReactions
              counts={reactions.counts}
              returnTo={returnTo}
              signedIn={signedIn}
              target={{ kind: 'subject', id }}
              value={reactions.value}
              personalReady={personalReady}
              {...(reactionOrigin ? { reactionOrigin } : {})}
              {...(onPersonalChange
                ? { onMutation: (kind) => onPersonalChange(kind as SubjectReactionKind | null) }
                : {})}
            />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground" role="status">
            {m.subject_reactions_unavailable()}
          </p>
        )}
        {reactionRecovery && (reactionRecovery.failed || reactionRecovery.pending) ? (
          <div className="flex items-center gap-2">
            <p className="text-sm text-muted-foreground" role="status">
              {reactionRecovery.pending ? m.subject_reaction_recovery_pending() : m.subject_reaction_recovery_failure()}
            </p>
            <button
              type="button"
              className="rounded-md px-2 py-1 text-sm underline"
              disabled={reactionRecovery.pending}
              onClick={reactionRecovery.retry}
            >
              {m.subject_reaction_recovery_retry()}
            </button>
          </div>
        ) : null}
        <div className="shrink-0">
          <PostActions target={{ kind: 'subject', id }} verification={verification} />
        </div>
      </div>
      <div
        className="flex min-w-0 flex-wrap items-center gap-2 sm:col-start-1 sm:row-start-2"
        data-slot="subject-library-actions"
      >
        {children}
        <FollowTargetControl targetId={id} />
      </div>
    </>
  );
}
