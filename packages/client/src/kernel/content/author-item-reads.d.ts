import { type AnchoredPosition, type ReadContext } from './model.ts';
import { type ItemView, type ContentReadDependencies, type ThreadView } from './reads.ts';
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
};
export type AuthorItemDependencies = ContentReadDependencies & {
    cursorNow?: () => number;
};
export type AuthorPage<T> = {
    entries: readonly T[];
    nextCursor: string | null;
    anchors: readonly AnchoredPosition[];
};
export declare function listAuthorThreads(dependencies: AuthorItemDependencies, accountId: string, context: ReadContext, input?: AuthorThreadPageInput): Promise<AuthorPage<ThreadView>>;
export declare function listAuthorPosts(dependencies: AuthorItemDependencies, accountId: string, context: ReadContext, input?: AuthorPageInput): Promise<AuthorPage<AuthorPostEntry>>;
