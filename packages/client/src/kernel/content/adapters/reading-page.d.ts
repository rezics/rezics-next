import type { ReadingPageOptional, ReadingPageMentionIdentity } from '../contract/index.ts';
import type { ReadingPageCapabilities } from './reading-page-bind.ts';
/** Composition adapts Access's producer contract into these Content consumption operands. */
export type ContentReadingAccess = Readonly<{
    observe<T>(read: () => Promise<T>, deadline?: number): Promise<ReadingPageOptional<T>>;
    identities(pool: object, ids: readonly string[], deadline?: number): Promise<ReadingPageOptional<readonly ReadingPageMentionIdentity[]>>;
}>;
/** No native pool is captured. Every invocation carries its original dependency holder and budget. */
export declare function createNativeReadingPageCapabilities(access: ContentReadingAccess): ReadingPageCapabilities;
