import type { FeedReactionCounts } from './feed-contract.ts';
import type { AnchoredPosition, FeedReviewContext, ReadContext } from './model.ts';
import { type ContentReadDependencies, type ReactionCountFreshness, type ThreadView, type ViewerReactionKind } from './reads.ts';
export type SubjectThreadWithReactions = ThreadView & Readonly<{
    reactions: FeedReactionCounts;
    viewerReaction?: ViewerReactionKind | null;
    reviewContext?: FeedReviewContext;
}>;
/** Adapt already disclosed native thread keys to Home's installed reaction producer.
 * The temporary feed items never become the Subject list's public identity.
 */
export declare function projectSubjectThreadReactions(dependencies: ContentReadDependencies, subjectId: string, placeId: string, selected: readonly ThreadView[], context: ReadContext): Promise<Readonly<{
    entries: readonly SubjectThreadWithReactions[];
    anchors: readonly AnchoredPosition[];
    reactionsAsOf: ReactionCountFreshness | null;
}>>;
