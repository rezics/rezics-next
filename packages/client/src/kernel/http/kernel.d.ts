import { type ContentHttpRoutes } from '../content/http.ts';
import { type CommerceMoneyPolicy } from '../commerce/money.ts';
import type { CurrentConsentReader } from '../access/auth-consent.ts';
import { zoneRoutes } from '../zones/http.ts';
import type { Elysia } from 'elysia';
import { viewerActionsRoutes, type ViewerActionResources, type ViewerActionBindings } from '../access/viewer-actions.ts';
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
import { readingInsightsRoutes } from '../library/reading-insights-routes.ts';
import { yearlyCompletionGoalRoutes } from '../library/yearly-goal-routes.ts';
import { diaryRoutes } from '../library/diary-routes.ts';
import { type RatingCapabilities, type RatingHttpApp } from '../rating/module.ts';
import type { ContentBoardDependencies } from '../content/boards.ts';
import type { TurnstileVerifier } from '../content/turnstile.ts';
import type { ContentRuntime } from '../content/runtime.ts';
import { bangumiImportRoutes } from '../library/list-import-bangumi-routes.ts';
import { malImportRoutes } from '../library/list-import-mal-routes.ts';
import { libraryExportRoutes } from '../library/library-export-routes.ts';
import { libraryArchiveMergeRoutes } from '../library/library-archive-merge-routes.ts';
import { copyArchiveRoutes } from '../library/copy-archive-routes.ts';
import { libraryArchiveCollectionRecoveryRoutes } from '../library/library-archive-collection-recovery-routes.ts';
import { personalLibraryRoutes } from '../library/personal-routes.ts';
import { aniListImportRoutes } from '../library/list-import-anilist-routes.ts';
import { vndbImportRoutes } from '../library/list-import-vndb-routes.ts';
import { type ShelfNativeReadBindings } from '../library/shelf-reader-defaults.ts';
import { type ContentShelfTitleInputs } from '../library/shelf-title-content-source.ts';
import type { ShelfTypeDigest } from '../library/shelf-type-keys.ts';
import { profileRoutes } from '../presentation/http/profiles.ts';
import type { Access, AccessConfig, AccessFactory, AccessRealmRoleReader } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { Pool } from 'pg';
import { type WorkClient } from '../work/client.ts';
import { recentSearchRoutes } from '../search/recent-searches.ts';
import { searchRoutes } from '../search/http/routes.ts';
import type { SearchService as SearchRuntime } from '../search/service-scope.ts';
import { definitionRoutes } from '../semantic/http/definitions.ts';
import type { DefinitionImportRoutes } from '../semantic/definition-import.ts';
import { contextRoutes } from '../semantic/http/contexts.ts';
import { bulkRoutes } from '../semantic/http/bulk.ts';
import { sourceRecordRoutes } from '../semantic/http/source-records.ts';
import { providerReviewQueueRoutes } from '../semantic/http/provider-review-queue.ts';
import { subjectPageRoutes } from '../semantic/http/subject-pages.ts';
import { createApp } from './app.ts';
export type KernelDependencies = Parameters<typeof createApp>[0] & {
    routeKey: Uint8Array;
    rating?: RatingCapabilities;
    /** Trusted post-catalogue binding; runs before the host admits any request. */
    onAccessReady?: (access: Access, viewerActions: {
        resources: ViewerActionResources;
        bindings: ViewerActionBindings;
    }) => void;
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
    content?: ContentRuntime & Partial<Pick<ContentBoardDependencies, 'cursorNow'>> & {
        readConsent?: CurrentConsentReader;
        /** Complete-input title observations; absent until Content installs its native producer. */
        shelfTitleInputs?: ContentShelfTitleInputs;
        now?: () => number;
        id?: () => string;
    };
    search?: SearchRuntime;
    /** Native shelf maintenance bindings; absence is a typed preparing response, never ready empty data. */
    shelves?: ShelfNativeReadBindings;
    /** Per-kernel private Type dictionary digest; defaults to SHA-256. */
    shelfTypeDigest?: ShelfTypeDigest;
    /** Optional entry preparation observation, after release of the source snapshots. */
    typeSourceObserved?: import('../library/type-preparation-contract.ts').TypePreparationSourceObserved;
    /** Trusted owner for the original funded frame around each complete private loan HTTP operation. */
    loanHttpWork?: import('../library/loan-operation-bounds.ts').LoanHttpWorkOwner;
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
/** A Realm's read grant gates every content item on its boards. Bind the
 * relationship before checkout, then recheck it with both read formulas at T.
 * Wrapping is identity-preserving: parent Content and worker authorization share
 * one wrap of the mounted Access.
 */
export declare function realmAwareContentAccess(access: Access): Access;
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
        v1: Pick<ReturnType<typeof zoneRoutes>['~Routes']['v1'], 'zones' | 'platform'>;
    };
};
type KernelComposition = ZoneComposition & ReturnType<typeof recentSearchRoutes> & ReturnType<typeof viewerActionsRoutes> & RatingHttpApp & ReturnType<typeof collectionRoutes> & ReturnType<typeof continueRoutes> & ReturnType<typeof feedRoutes> & ReturnType<typeof pinRoutes> & ReturnType<typeof personalLabelRoutes> & ReturnType<typeof personalLibraryRoutes> & ReturnType<typeof bangumiImportRoutes> & ReturnType<typeof malImportRoutes> & ReturnType<typeof aniListImportRoutes> & ReturnType<typeof vndbImportRoutes> & ReturnType<typeof libraryExportRoutes> & ReturnType<typeof libraryArchiveMergeRoutes> & ReturnType<typeof copyArchiveRoutes> & ReturnType<typeof libraryArchiveCollectionRecoveryRoutes> & ReturnType<typeof communityRoutes> & ReturnType<typeof exposureRoutes> & ReturnType<typeof subjectPageRoutes> & ReturnType<typeof bulkRoutes> & ReturnType<typeof sourceRecordRoutes> & ReturnType<typeof profileRoutes> & ReturnType<typeof accessRoutes> & ReturnType<typeof erasureStatusRoutes> & ContentHttpRoutes & ReturnType<typeof searchRoutes> & ReturnType<typeof payoutRoutes> & ReturnType<typeof commerceRoutes> & ReturnType<typeof progressRoutes> & ReturnType<typeof readingInsightsRoutes> & ReturnType<typeof yearlyCompletionGoalRoutes> & ReturnType<typeof diaryRoutes> & ReturnType<typeof contextRoutes> & ReturnType<typeof providerReviewQueueRoutes>;
export type Kernel = KernelComposition;
type ClientRoutes<Routes, Base> = {
    [Key in keyof Routes]: Key extends keyof Base ? Base[Key] extends {
        body: unknown;
        response: unknown;
    } ? Base[Key] : ClientRoutes<Routes[Key], Base[Key]> : Routes[Key];
};
/** createKernel guarantees one parameter name for each route position. */
export type ClientKernel = Elysia<KernelComposition['~Prefix'], 'local', KernelComposition['~Singleton'], KernelComposition['~Definitions'], KernelComposition['~Metadata'], ClientRoutes<KernelComposition['~Routes'], ReturnType<typeof definitionRoutes>['~Routes']> & DefinitionImportRoutes, KernelComposition['~Ephemeral'], KernelComposition['~Volatile']>;
export {};
