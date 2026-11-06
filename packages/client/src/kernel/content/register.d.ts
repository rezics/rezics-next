import { contentDeclaredEvents } from './declared-catalogue.ts';
import { type CurrentConsentReader } from '../access/auth-consent.ts';
import type { KernelClock } from '../clock.ts';
import type { Pool } from 'pg';
import { contentEffects, contentNoticeEffects } from './relays.ts';
import type { WorkModule } from '../work/registry.ts';
import type { MediaStorage } from './media-storage.ts';
import type { MediaImportFetchConfig } from './media-import.ts';
import { type ContentWorkConfig } from './work-config.ts';
import type { ContentPool } from './contract/index.ts';
/** Standalone fixture/caller Access with the shared role catalogue. Default
 * production registration uses WorkContext's fully mounted authorization instead.
 * Reads outside a command bind this kernel clock. */
export declare function createContentWorkAccess(clock: KernelClock, pool?: Pool): import("../request/access.ts").Access;
/** A configured dependency is absent. The call touches no storage, network or operation state. */
export declare class ContentDependencyUnavailableError extends Error {
    readonly code: 'dependency_unavailable';
    constructor();
}
export type ContentWorkDependencies = Readonly<{
    config: ContentWorkConfig;
    absentGroups: readonly Readonly<{
        name: string;
        variables: readonly string[];
    }>[];
    storage: MediaStorage;
    readConsent: CurrentConsentReader;
    fetchConfig: MediaImportFetchConfig;
}>;
/** One port factory for registration and tests. Absent groups fail closed and do not construct a client. */
export declare function contentWorkDependencies(env: Readonly<Record<string, string | undefined>>, fetchImpl: (request: Request) => Promise<Response>): ContentWorkDependencies;
/** Network, wall-clock budgets and request IDs are explicit operands supplied by the composition root. */
export type ContentWorkAmbient = Readonly<{
    fetch: (request: Request) => Promise<Response>;
    now?: () => number;
    id?: () => string;
}>;
/** Content's declared effects. The worker register consumes this; tests may install the same list. */
export declare function contentDeclaredEffects(pool: ContentPool, client: Parameters<typeof contentEffects>[1], access: Parameters<typeof contentNoticeEffects>[1]): readonly import("../events/effects.ts").Effect[];
/** Content's declared surfaces, read by the composition root. Events, operations and permissions are data;
 * the worker is a factory over explicit operands. HTTP composition extends this with `mount`. */
export declare function contentDeclaration(): Readonly<{
    name: 'content';
    events: typeof contentDeclaredEvents;
    operations: readonly Readonly<{
        operationId: string;
        method: import("@rezics/operations").OperationMethod;
        path: string;
        action: string;
        audience: import("@rezics/operations").OperationAudience;
        security: readonly import("@rezics/operations").OperationSecurity[];
        exposure: string;
        resourceTypes: readonly string[];
        replayAuthorization?: 'self-account-read';
        authority?: import("@rezics/operations").OperationAuthority;
        rateLimit?: import("@rezics/operations").OperationRateLimit;
        contracts: import("@rezics/operations").OperationContractReferences;
    }>[];
    permissions: import("../access/viewer-actions.ts").ViewerActionResources;
    work: typeof createContentWorkModule;
    effects: typeof contentDeclaredEffects;
}>;
/** Content's worker registration, constructed from the composition's explicit operands. Configuration comes
 * from the shared work context; nothing here reads the process environment, the network or the clock at load. */
export declare function createContentWorkModule(ambient: ContentWorkAmbient): WorkModule;
