import { type AnchoredPosition, type ReadContext } from './model.ts';
import { type ItemView, type ContentReadDependencies, type ThreadView } from './reads.ts';
import type { AuthorContributionSelection } from './author-contribution-actions-schema.ts';
export { decodeAuthorItemKey, encodeAuthorItemKey } from './author-item-cursor.ts';
export type { AuthorItemCursorKey } from './author-item-cursor.ts';
import { type AuthorItemContext } from './author-item-context.ts';
export type AuthorThreadKind = 'discussion' | 'review';
export type AuthorPageInput = {
    cursor?: string;
    limit?: number;
};
export type AuthorThreadPageInput = AuthorPageInput & {
    kind?: AuthorThreadKind;
};
export type AuthorPostEntry = Extract<ItemView, {
    availability: 'available';
}> & {
    thread: {
        id: string;
        title: string | null;
    };
} & Partial<AuthorItemContext>;
export type AuthorThreadEntry = ThreadView & Partial<AuthorItemContext>;
export type AuthorItemDependencies = ContentReadDependencies & {
    routeKey: Uint8Array;
    cursorNow: () => number;
};
export type AuthorPage<T> = {
    entries: readonly T[];
    nextCursor: string | null;
    anchors: readonly AnchoredPosition[];
    actionSelection?: AuthorContributionSelection;
};
export declare function listAuthorThreads(dependencies: AuthorItemDependencies, accountId: string, context: ReadContext, input?: AuthorThreadPageInput): Promise<AuthorPage<AuthorThreadEntry>>;
export declare function listAuthorPosts(dependencies: AuthorItemDependencies, accountId: string, context: ReadContext, input?: AuthorPageInput): Promise<AuthorPage<AuthorPostEntry>>;
