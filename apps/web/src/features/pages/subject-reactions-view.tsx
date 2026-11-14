import type { ReactNode } from 'react';
import { PublicReactionRecovery } from './public-reaction-recovery';
import { m } from '../../paraglide/messages.js';
import { locales } from '../../paraglide/runtime.js';
import { PostActions } from '../../report/content-actions';
import type { VerificationConfig } from '../../report/turnstile';
import { ThreadReactions } from '../../threads/thread-reactions';
import type { SubjectReactionKind, SubjectReactions } from './subject-reactions';
import { FollowTargetControl } from '../../library/follow-target-control';

const actionRowClass =
  'flex min-w-0 w-full flex-wrap gap-2 [&_a]:h-auto [&_a]:min-h-11 [&_a]:min-w-11 [&_a]:max-w-full [&_a]:whitespace-normal [&_a]:wrap-anywhere [&_button]:h-auto [&_button]:min-h-11 [&_button]:min-w-11 [&_button]:max-w-full [&_button]:whitespace-normal [&_button]:wrap-anywhere';

/**
 * Library actions lead at the available header width; reactions, follow and overflow wrap in a separate row.
 * Reporting lives only in the menu. When the counts could not be read the cluster says so
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
  publicRecovery,
  locale = 'en',
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
  publicRecovery?: { pending: boolean; retry(): void };
  locale?: string;
  children?: ReactNode;
}) {
  const options = { locale: locales.find((item) => item === locale) ?? 'en' };
  return (
    <>
      <div className={`${actionRowClass} items-center`} data-slot="subject-library-actions">
        {children}
      </div>
      <div className={`${actionRowClass} items-start`} data-slot="subject-header-actions">
        <PublicReactionRecovery
          key={JSON.stringify([id, locale])}
          available={reactions !== null}
          pending={publicRecovery?.pending ?? false}
          retry={publicRecovery?.retry}
          labels={{
            group: m.subject_reaction_counts_group({}, options),
            pending: m.subject_reaction_counts_pending({}, options),
            unavailable: m.subject_reactions_unavailable({}, options),
            retry: m.subject_reaction_counts_retry({}, options),
          }}
        >
          {reactions && (
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
          )}
        </PublicReactionRecovery>
        {reactionRecovery && (reactionRecovery.failed || reactionRecovery.pending) ? (
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <p className="text-sm text-muted-foreground" role="status">
              {reactionRecovery.pending ? m.subject_reaction_recovery_pending() : m.subject_reaction_recovery_failure()}
            </p>
            <button
              type="button"
              className="min-h-11 min-w-11 rounded-md px-2 py-1 text-sm underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              disabled={reactionRecovery.pending}
              onClick={reactionRecovery.retry}
            >
              {m.subject_reaction_recovery_retry()}
            </button>
          </div>
        ) : null}
        <FollowTargetControl targetId={id} />
        <div className="min-w-0 max-w-full">
          <PostActions target={{ kind: 'subject', id }} verification={verification} />
        </div>
      </div>
    </>
  );
}
