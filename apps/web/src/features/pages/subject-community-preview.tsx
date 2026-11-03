import { m } from '../../paraglide/messages.js';
import type { ReactionKind } from '../../threads/reaction-request';
import { RevisionProvenance } from '../../threads/revision-provenance-view';
import type { ThreadSubject } from '../../threads/subjects';
import type { CommunityKind, CommunityThread } from './subject-community';

const reactionLabels: Record<ReactionKind, () => string> = {
  upvote: () => m.reaction_upvote(),
  downvote: () => m.reaction_downvote(),
  like: () => m.reaction_like(),
  love: () => m.reaction_love(),
  laugh: () => m.reaction_laugh(),
  insightful: () => m.reaction_insightful(),
  sad: () => m.reaction_sad(),
};

function ReadOnlyReactionCounts({ thread, locale }: { thread: CommunityThread; locale: string }) {
  if (thread.reactions === undefined)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {m.subject_reactions_unavailable()}
      </p>
    );
  const format = (value: number) => new Intl.NumberFormat(locale).format(value);
  const entries = (Object.keys(reactionLabels) as ReactionKind[])
    .map((kind) => [kind, thread.reactions?.[kind] ?? 0] as const)
    .filter(([, count]) => count > 0);
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  return (
    <div data-slot="community-reaction-summary" className="space-y-1 text-sm text-muted-foreground">
      <p>{m.board_feed_reactions({ count: format(total) })}</p>
      {entries.length > 0 ? (
        <ul aria-label={m.reaction_reactions()} className="flex flex-wrap gap-x-3 gap-y-1">
          {entries.map(([kind, count]) => (
            <li key={kind}>
              {reactionLabels[kind]()} {format(count)}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Retains only the cited first-post rating and current page Subject context. No current vote is read here. */
export function SubjectCommunityPreview({
  kind,
  thread,
  subject,
  locale,
  reader,
  interactionReady,
}: {
  kind: CommunityKind;
  thread: CommunityThread;
  subject: { id: string; label: string };
  locale: string;
  reader: string | null;
  interactionReady: boolean;
}) {
  const subjects: ThreadSubject[] = [
    { id: subject.id, types: [], label: subject.label, labels: { [locale]: subject.label }, cover: null },
  ];
  return (
    <div className="min-w-0 space-y-2" data-slot="subject-community-preview">
      {kind === 'review' ? (
        <div
          data-slot="review-citation"
          data-state={
            thread.voteCitation === undefined ? 'unavailable' : thread.voteCitation === null ? 'unscored' : 'cited'
          }
        >
          {thread.voteCitation === undefined ? (
            <p role="status" className="text-sm text-muted-foreground">
              {m.subject_community_citation_unavailable()}
            </p>
          ) : (
            <RevisionProvenance
              revision={{ licence: thread.licence, subjectIds: [subject.id], voteCitation: thread.voteCitation }}
              subjects={subjects}
              review
              showLicence={false}
            />
          )}
        </div>
      ) : null}
      {!interactionReady ? <ReadOnlyReactionCounts thread={thread} locale={locale} /> : null}
      {!interactionReady && reader !== null && thread.viewerReaction === undefined ? (
        <p role="status" className="text-sm text-muted-foreground">
          {m.subject_community_viewer_reaction_unavailable()}
        </p>
      ) : null}
    </div>
  );
}
