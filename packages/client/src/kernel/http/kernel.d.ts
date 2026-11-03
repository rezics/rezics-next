import { type CommerceMoneyPolicy } from '../commerce/money.ts';
import type { CurrentConsentReader } from '../access/auth-consent.ts';
import { zoneRoutes } from '../zones/http.ts';
import type { Elysia } from 'elysia';
import { viewerActionsRoutes, type ViewerActionResources } from '../access/viewer-actions.ts';
import { accessRoutes } from '../access/routes.ts';
import { erasureStatusRoutes } from '../access/erasure-status-route.ts';
import { exposureRoutes } from '../access/gates/routes.ts';
import { communityRoutes } from '../community/routes.ts';
import { payoutRoutes } from '../commerce/payout-routes.ts';
import { commerceRoutes, type CommerceDependencies } from '../commerce/routes.ts';
import { collectionRoutes } from '../library/collection-routes.ts';
import { continueRoutes } from '../library/continue-routes.ts';
import { feedRoutes } from '../content/feed-routes.ts';
import { personalLabelRoutes } from '../library/label-routes.ts';
import { pinRoutes } from '../library/pin-routes.ts';
import { progressRoutes } from '../library/progress-routes.ts';
import { diaryRoutes } from '../library/diary-routes.ts';
import { ratingRoutes } from '../rating/routes.ts';
import { sourceStatisticRoutes } from '../rating/source-statistics.ts';
import type { ContentBoardDependencies } from '../content/boards.ts';
import { mediaRoutes } from '../content/media-routes.ts';
import { contentRoutes, subjectReactionRoutes } from '../content/routes.ts';
import { noticeRoutes } from '../content/notice-routes.ts';
import type { TurnstileVerifier } from '../content/turnstile.ts';
import type { ContentRuntime } from '../content/runtime.ts';
import { bangumiImportRoutes } from '../library/list-import-bangumi-routes.ts';
import { malImportRoutes } from '../library/list-import-mal-routes.ts';
import { personalLibraryRoutes } from '../library/personal-routes.ts';
import { type ShelfNativeReadBindings } from '../library/shelf-reader-defaults.ts';
import type { ShelfTypeDigest } from '../library/shelf-type-keys.ts';
import { profileRoutes } from '../presentation/http/profiles.ts';
import type { Access, AccessConfig, AccessFactory, AccessRealmRoleReader } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { Pool } from 'pg';
import { type WorkClient } from '../work/client.ts';
import { recentSearchRoutes } from '../search/recent-searches.ts';
import { searchRoutes, type SearchService } from '../search/http/routes.ts';
import { definitionRoutes } from '../semantic/http/definitions.ts';
import { contextRoutes } from '../semantic/http/contexts.ts';
import { bulkRoutes } from '../semantic/http/bulk.ts';
import { sourceRecordRoutes } from '../semantic/http/source-records.ts';
import { providerReviewQueueRoutes } from '../semantic/http/provider-review-queue.ts';
import { subjectPageRoutes } from '../semantic/http/subject-pages.ts';
import { createApp } from './app.ts';
export type KernelDependencies = Parameters<typeof createApp>[0] & {
    routeKey: Uint8Array;
    /** Trusted post-catalogue binding; runs before the host admits any request. */
    onAccessReady?: (access: Access) => void;
    /** Dedicated durable HMAC configuration, independent of ephemeral token defaults. */
    receiptKeys?: KeyRing;
    /** Trusted modules mount declarations before composition validation. */
    modules?: readonly ((app: ReturnType<typeof createApp>) => void)[];
    viewerActionResources?: ViewerActionResources;
    resourceRoles?: import('../access/resource-roles.ts').ResourceRoleCatalogue;
    /** Trusted domain time only; authentication and request budgets retain real time. */
    clock?: () => Date;
    commerce?: CommerceDependencies;
    moneyPolicy?: CommerceMoneyPolicy;
    content?: ContentRuntime & Pick<ContentBoardDependencies, 'cursorNow'> & {
        readConsent?: CurrentConsentReader;
    };
    search?: SearchService;
    /** Native shelf maintenance bindings; absence is a typed preparing response, never ready empty data. */
    shelves?: ShelfNativeReadBindings;
    /** Per-kernel private Type dictionary digest; defaults to SHA-256. */
    shelfTypeDigest?: ShelfTypeDigest;
    /** Optional entry preparation observation, after release of the source snapshots. */
    typeSourceObserved?: import('../library/type-preparation-contract.ts').TypePreparationSourceObserved;
    discovery?: import('../search/discovery-service.ts').DiscoverySearch;
    /** Trusted verifier binding; runtime secret/env composition belongs to the service. */
    reports?: {
        anonymousVerifier?: TurnstileVerifier;
    };
    /** Enqueue-only client. Tests close the instance they pass. */
    workClient?: WorkClient;
    /** Test and deployment override for the kernel-registered current Realm role reader. */
    realmRoleReader?: AccessRealmRoleReader;
};
export declare class KernelAccessCompositionError extends Error {
    constructor();
}
/** One Access per kernel, built on first use after composition from the complete
 * mounted catalogue; composition code receives Access lazily. Standalone test
 * compositions may supply their already-complete catalogue in resolveAccess.
 */
export declare function createKernelAccessResolver(options: {
    pool: Pool;
    tokens: KeyRing;
    clock: () => Date;
    access?: Access | AccessFactory;
    realmRoleReader?: AccessRealmRoleReader;
    /** Undefined until the kernel has mounted its last route. */
    composedActions?: () => AccessConfig['actions'] | undefined;
}): {
    resolveAccess: (config: AccessConfig) => Access;
    realmRoleReader: AccessRealmRoleReader;
};
/** The route key must stay the same across restarts, or retries lose their receipts. */
export declare function createKernel(dependencies: KernelDependencies): Kernel;
type ZoneComposition = Omit<ReturnType<typeof zoneRoutes>, '~Routes'> & {
    '~Routes': {
        v1: Pick<ReturnType<typeof zoneRoutes>['~Routes']['v1'], 'zones'>;
    };
};
type KernelComposition = ZoneComposition & ReturnType<typeof recentSearchRoutes> & ReturnType<typeof viewerActionsRoutes> & ReturnType<typeof sourceStatisticRoutes> & ReturnType<typeof ratingRoutes> & ReturnType<typeof collectionRoutes> & ReturnType<typeof continueRoutes> & ReturnType<typeof feedRoutes> & ReturnType<typeof pinRoutes> & ReturnType<typeof personalLabelRoutes> & ReturnType<typeof personalLibraryRoutes> & ReturnType<typeof bangumiImportRoutes> & ReturnType<typeof malImportRoutes> & ReturnType<typeof communityRoutes> & ReturnType<typeof exposureRoutes> & ReturnType<typeof subjectPageRoutes> & ReturnType<typeof bulkRoutes> & ReturnType<typeof sourceRecordRoutes> & ReturnType<typeof profileRoutes> & ReturnType<typeof accessRoutes> & ReturnType<typeof erasureStatusRoutes> & ReturnType<typeof mediaRoutes> & ReturnType<typeof contentRoutes> & ReturnType<typeof noticeRoutes> & ReturnType<typeof subjectReactionRoutes> & ReturnType<typeof searchRoutes> & ReturnType<typeof payoutRoutes> & ReturnType<typeof commerceRoutes> & ReturnType<typeof progressRoutes> & ReturnType<typeof diaryRoutes> & ReturnType<typeof contextRoutes> & ReturnType<typeof providerReviewQueueRoutes>;
export type Kernel = KernelComposition;
type ClientRoutes<Routes, Base> = {
    [Key in keyof Routes]: Key extends keyof Base ? Base[Key] extends {
        body: unknown;
        response: unknown;
    } ? Base[Key] : ClientRoutes<Routes[Key], Base[Key]> : Routes[Key];
};
/** createKernel guarantees one parameter name for each route position. */
export type ClientKernel = Elysia<KernelComposition['~Prefix'], 'local', KernelComposition['~Singleton'], KernelComposition['~Definitions'], KernelComposition['~Metadata'], ClientRoutes<KernelComposition['~Routes'], ReturnType<typeof definitionRoutes>['~Routes']>, KernelComposition['~Ephemeral'], KernelComposition['~Volatile']>;
export {};
