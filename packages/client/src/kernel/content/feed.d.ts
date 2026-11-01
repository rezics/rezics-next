import type { Pool } from 'pg';
import type { Access, Actor } from '../request/access.ts';
import type { KernelClock } from '../clock.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { WorkClient } from '../work/client.ts';
import type { DiscoverySearch } from '../search/discovery-service.ts';
import type { SearchService } from '../search/service-scope.ts';
import { type FeedPage } from './feed-contract.ts';
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
};
export declare function createFeedReads(deps: FeedDependencies): {
    list(actor: Actor, query: {
        stream?: 'home' | 'following';
        limit?: number;
        cursor?: string;
        kind?: string;
    }, deadline: number, languages: readonly string[]): Promise<FeedPage>;
};
