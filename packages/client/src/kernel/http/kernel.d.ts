import type { Elysia } from 'elysia';
import { accessRoutes } from '../access/routes.ts';
import { exposureRoutes } from '../access/gates/routes.ts';
import { communityRoutes } from '../community/routes.ts';
import { payoutRoutes } from '../commerce/payout-routes.ts';
import { commerceRoutes, type CommerceDependencies } from '../commerce/routes.ts';
import { collectionRoutes } from '../library/collection-routes.ts';
import { progressRoutes } from '../library/progress-routes.ts';
import { ratingRoutes } from '../rating/routes.ts';
import { sourceStatisticRoutes } from '../rating/source-statistics.ts';
import type { ContentBoardDependencies } from '../content/boards.ts';
import { mediaRoutes } from '../content/media-routes.ts';
import { contentRoutes } from '../content/routes.ts';
import type { TurnstileVerifier } from '../content/turnstile.ts';
import type { ContentRuntime } from '../content/runtime.ts';
import { personalLibraryRoutes } from '../library/personal-routes.ts';
import { profileRoutes } from '../presentation/http/profiles.ts';
import type { Access, AccessConfig, AccessFactory, AccessRealmRoleReader } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { Pool } from 'pg';
import { type WorkClient } from '../work/client.ts';
import { searchRoutes, type SearchService } from '../search/http/routes.ts';
import { contextRoutes } from '../semantic/http/contexts.ts';
import { bulkRoutes } from '../semantic/http/bulk.ts';
import { subjectPageRoutes } from '../semantic/http/subject-pages.ts';
import { createApp } from './app.ts';
export type KernelDependencies = Parameters<typeof createApp>[0] & {
    routeKey: Uint8Array;
    /** Trusted domain time only; authentication and request budgets retain real time. */
    clock?: () => Date;
    commerce?: CommerceDependencies;
    content?: ContentRuntime & Pick<ContentBoardDependencies, 'cursorNow'>;
    search?: SearchService;
    /** Trusted verifier binding; runtime secret/env composition belongs to the service. */
    reports?: {
        anonymousVerifier?: TurnstileVerifier;
    };
    /** Enqueue-only client. Tests close the instance they pass. */
    workClient?: WorkClient;
};
/** Builds the Access resolver shared by production kernels and test compositions. */
export declare function createKernelAccessResolver(options: {
    pool: Pool;
    tokens: KeyRing;
    clock: () => Date;
    access?: Access | AccessFactory;
    realmRoleReader?: AccessRealmRoleReader;
}): {
    resolveAccess: (config: AccessConfig) => Access;
    realmRoleReader: AccessRealmRoleReader;
};
/** The route key must stay the same across restarts, or retries lose their receipts. */
export declare function createKernel(dependencies: KernelDependencies): Kernel;
type KernelComposition = ReturnType<typeof sourceStatisticRoutes> & ReturnType<typeof ratingRoutes> & ReturnType<typeof collectionRoutes> & ReturnType<typeof personalLibraryRoutes> & ReturnType<typeof communityRoutes> & ReturnType<typeof exposureRoutes> & ReturnType<typeof subjectPageRoutes> & ReturnType<typeof bulkRoutes> & ReturnType<typeof profileRoutes> & ReturnType<typeof accessRoutes> & ReturnType<typeof mediaRoutes> & ReturnType<typeof contentRoutes> & ReturnType<typeof searchRoutes> & ReturnType<typeof payoutRoutes> & ReturnType<typeof commerceRoutes> & ReturnType<typeof progressRoutes> & ReturnType<typeof contextRoutes>;
export type Kernel = KernelComposition;
/** createKernel guarantees one parameter name for each route position. */
export type ClientKernel = Elysia<KernelComposition['~Prefix'], 'local', KernelComposition['~Singleton'], KernelComposition['~Definitions'], KernelComposition['~Metadata'], KernelComposition['~Routes'], KernelComposition['~Ephemeral'], KernelComposition['~Volatile']>;
export {};
