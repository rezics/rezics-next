import type { Pool } from 'pg';
import type { Access, Actor } from '../request/access.ts';
import type { KernelClock } from '../clock.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { WorkClient } from '../work/client.ts';
import type { DiscoverySearch } from '../search/index.ts';
import type { SearchService } from '../search/service-scope.ts';
import type { ViewerPersonalActionsReader } from '../library/viewer-personal-actions.ts';
import { type FeedPage, type FeedSelection } from './feed-contract.ts';
import type { ReadingPageViewerActionRuntime } from './reading-page.ts';
export type FeedDependencies = {
    pool: Pool;
    routeKey: Uint8Array;
    tokens: KeyRing;
    clock: KernelClock;
    access: Access;
    contentAccess: Access;
    workClient: () => Promise<WorkClient>;
    discovery?: DiscoverySearch;
    search?: SearchService;
    /** Home calls this bounded seam only after its feed candidates are admitted and disclosed. */
    viewerPersonalActions: ViewerPersonalActionsReader;
    /** Reuse the mounted Content reading-page action catalogue for selected Home targets. */
    viewerActionRuntime?: () => ReadingPageViewerActionRuntime;
};
/** The native factory and mounted route share this query and response contract. */
export type FeedReadQuery = {
    stream?: 'home' | 'following';
    limit?: number;
    cursor?: string;
    kind?: string;
} & FeedSelection;
export type FeedReads = {
    list(actor: Actor, query: FeedReadQuery, deadline: number, languages: readonly string[]): Promise<FeedPage>;
};
export declare const FEED_PAGE_LIMIT = 20;
export declare const FEED_CANDIDATE_LIMIT = 160;
export declare const FEED_CONTINUE_WIDTH = 6;
export declare const FEED_CONTINUE_CANDIDATES = 39;
export declare const FEED_DISCOVERY_CANDIDATES_PER_RESULT = 6;
export declare const FEED_DISCOVERY_FIXED_CANDIDATES = 3;
export declare const FEED_ACCOUNT_BATCH_LIMIT = 100;
export declare const FEED_AUTHOR_KEYS_PER_CANDIDATE = 3;
export declare const FEED_SPACE_FIXED_KEYS = 4;
export declare const FEED_SPACE_BOARD_KEYS_PER_CANDIDATE = 1;
export declare const feedCandidateBound: (discovery: number, following: number, continued: boolean) => number;
export declare function createFeedReads(deps: FeedDependencies): FeedReads;
