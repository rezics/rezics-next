import { type CursorBinding } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { type AnchoredPosition, type ReadContext } from './model.ts';
import { type ItemView, type ContentReadDependencies, type ThreadView } from './reads.ts';
import type { AuthorContributionSelection } from './author-contribution-actions-schema.ts';
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
    cursorNow?: () => number;
};
export type AuthorPage<T> = {
    entries: readonly T[];
    nextCursor: string | null;
    anchors: readonly AnchoredPosition[];
    actionSelection?: AuthorContributionSelection;
};
type Key = {
    createdAt: string;
    itemId: string;
};
export declare function encodeAuthorItemKey(ring: KeyRing, scope: CursorBinding, key: Key, epoch: number, now: number): string;
export declare function decodeAuthorItemKey(ring: KeyRing, scope: CursorBinding, token: string, epoch: number, now: number): Key;
export declare function listAuthorThreads(dependencies: AuthorItemDependencies, accountId: string, context: ReadContext, input?: AuthorThreadPageInput): Promise<AuthorPage<AuthorThreadEntry>>;
export declare function listAuthorPosts(dependencies: AuthorItemDependencies, accountId: string, context: ReadContext, input?: AuthorPageInput): Promise<AuthorPage<AuthorPostEntry>>;
export {};
