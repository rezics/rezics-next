import type { FeedConversationActivity } from './feed-contract.ts';
import type { AnchoredPosition, FeedParentContext, FeedReviewContext, ReadContext } from './model.ts';
import { type ContentReadDependencies, type PostEntry, type ThreadView } from './reads.ts';
export type AuthorContextReference = Readonly<{
    thread: ThreadView;
    post?: PostEntry;
}>;
export type AuthorItemContext = Readonly<{
    parentContext?: FeedParentContext;
    conversationActivity: FeedConversationActivity;
    reviewContext?: FeedReviewContext;
}>;
type AuthorItemContextDependencies = ContentReadDependencies & Readonly<{
    routeKey: Uint8Array;
}>;
/** Selected native parents only; anonymous disclosure never inherits an editor's
 * rights. No account labels, media, recursive context or private viewer slots.
 * Native readPost retains responsibility for ancestor/place/Access admission.
 */
export declare function prepareAuthorItemContext(dependencies: AuthorItemContextDependencies, references: readonly AuthorContextReference[], context: ReadContext): Promise<Readonly<{
    anchors: AnchoredPosition[];
    finish(): Promise<ReadonlyMap<string, AuthorItemContext>>;
    confirm(): Promise<void>;
}>>;
export {};
