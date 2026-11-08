import type { FeedAuthor } from './feed-contract.ts';
import type { ContentReadDependencies, PostEntry, ThreadView } from './reads.ts';
import type { AnchoredPosition, FeedParentContext, FeedReviewContext, ReadContext } from './model.ts';
import type { FeedEnrichmentPorts } from './feed-enrichment-ports.ts';
export declare const FEED_CONTEXT_MAX_REFERENCES = 20;
export declare const FEED_CONTEXT_MAX_AUTHORS: number;
export declare const FEED_CONTEXT_MAX_SUBJECTS = 20;
export declare const FEED_CONTEXT_MAX_QUESTIONS = 20;
export declare const FEED_PARENT_PREVIEW_BYTES = 640;
/** Owner summaries use the service's trusted routing key, never a reader-selected route. */
export type FeedContentContextDependencies = ContentReadDependencies & Readonly<{
    routeKey: Uint8Array;
}>;
export type FeedContentContextReference = Readonly<{
    key: string;
    threadId: string;
    postId?: string;
    initialThread?: ThreadView;
    initialPost?: PostEntry;
}>;
export type FeedContentContextValue = Readonly<{
    thread: ThreadView | null;
    post: PostEntry | null;
    threadAuthor?: FeedAuthor;
    postAuthor?: FeedAuthor;
    reviewContext?: FeedReviewContext;
    parentContext?: FeedParentContext;
}>;
export type FeedThreadObserver = (threadIds: readonly string[], context: ReadContext) => Promise<readonly Readonly<{
    value: ThreadView | null;
    anchor: AnchoredPosition;
}>[]>;
export type FeedContentContextFinished = Readonly<{
    contexts: ReadonlyMap<string, FeedContentContextValue>;
    anchors: readonly AnchoredPosition[];
}>;
export type FeedContentContextComposition = Readonly<{
    finish(): Promise<FeedContentContextFinished>;
}>;
type ContextOwnerOptions = Readonly<{
    /** A current question is not a presentation of the recorded vote revision. */
    questionMetadata?: 'current' | 'unavailable';
    confirmSubjects?: boolean;
    authors?: boolean;
}>;
export type FeedContentContextOptions = ContextOwnerOptions & Readonly<{
    observeThreads?: FeedThreadObserver;
}>;
/** Prepare one selected page of native review and immediate-parent context.
 * `finish` repeats all selected Content keys after owner hydration; Subject pages
 * pass their exact subject/place observer so membership stays with that owner. */
export declare function prepareFeedContentContext(dependencies: FeedContentContextDependencies, enrichment: FeedEnrichmentPorts, references: readonly FeedContentContextReference[], context: ReadContext, languages?: readonly string[], options?: FeedContentContextOptions): Promise<FeedContentContextComposition>;
export {};
