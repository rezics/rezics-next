import type { ReactNode } from 'react';
import { m } from '../../paraglide/messages.js';
import { PostActions } from '../../report/content-actions';
import type { VerificationConfig } from '../../report/turnstile';
import { ThreadReactions } from '../../threads/thread-reactions';
import type { SubjectReactions } from './subject-reactions';

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
  children,
}: {
  id: string;
  reactions: SubjectReactions | null;
  signedIn: boolean;
  returnTo: string;
  verification: VerificationConfig;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3 sm:items-end" data-slot="subject-actions">
      <div className="flex items-start gap-2 sm:justify-end">
        {reactions ? (
          <div className="min-w-0 flex-1 sm:flex-none">
            <ThreadReactions
              counts={reactions.counts}
              returnTo={returnTo}
              signedIn={signedIn}
              target={{ kind: 'subject', id }}
              value={reactions.value}
            />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground" role="status">
            {m.subject_reactions_unavailable()}
          </p>
        )}
        <div className="shrink-0">
          <PostActions target={{ kind: 'subject', id }} verification={verification} />
        </div>
      </div>
      {children}
    </div>
  );
}
