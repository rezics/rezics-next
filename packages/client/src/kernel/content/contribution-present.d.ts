import { type ContributionAttribution } from '../access/public-identity.ts';
import type { Anchored, ReadContext } from './model.ts';
import { type ContentReadDependencies, type PostEntry } from './reads.ts';
type Attributed<T> = T extends {
    readonly authorId: string;
} ? Omit<T, 'authorId'> & {
    readonly authorId?: string;
    readonly attribution: ContributionAttribution;
    readonly parent?: {
        readonly postId: string;
        readonly attribution: ContributionAttribution;
    };
} : T;
/** Public serialization is distinct from native author identity used for authorization. */
export type ContributedPostEntry = Attributed<PostEntry>;
export declare function presentContributedPost(post: PostEntry, identities: ReadonlyMap<string, ContributionAttribution>, parent?: PostEntry): ContributedPostEntry;
/** One exact point and at most one disclosed parent, sharing a deduplicated Accounts batch. */
export declare function readContributedPost(dependencies: ContentReadDependencies, threadId: string, postId: string, context: ReadContext): Promise<Anchored<ContributedPostEntry>>;
export {};
