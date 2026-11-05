import type { NativeStepWork } from './identity-epoch-contract.ts';
import type { WorkDimensions } from '../library/collection-source.ts';
type Environment = Readonly<Record<string, string | undefined>>;
/** Executed by the private Source receiver, rather than inferred from page size.
 * An exhausted-page recheck is the second verifier inside the Source fence; it is
 * not a Library finishScope/finalFence. Planning belongs to the Library participant.
 */
export declare const IDENTITY_SOURCE_ORIGINAL_SCHEDULE: Readonly<{
    custodyAdvancements: 1;
    directoryPages: 1;
    source: Readonly<{
        retainedDiscovery: 1;
        original: 1;
        acceptedBinding: 1;
        published: 2;
        participantReconcile: 3;
        prepare: 1;
        retainedFallback: 1;
        progress: 1;
        directory: 1;
        directoryRecheck: 1;
        scopeAdmission: 1;
        receivingSelection: 1;
        receivingReconcile: 1;
        receivingCommand: 1;
        checkpoint: 1;
        finish: 1;
        terminalVerify: 1;
        historyAuthority: 1;
        historyHandoff: 1;
    }>;
    library: Readonly<{
        discovery: 0;
        plannerSteps: 0;
        effectPages: 1;
        currentVerifications: 1;
        exhaustedPageRechecks: 1;
        finalFences: 0;
    }>;
}>;
export type IdentitySourceLibraryOperation = keyof typeof IDENTITY_SOURCE_ORIGINAL_SCHEDULE.library;
export type IdentitySourceScheduledOperation = keyof typeof IDENTITY_SOURCE_ORIGINAL_SCHEDULE.source;
export type IdentitySourceMaintenanceConfig = Readonly<{
    native: NativeStepWork;
    library: WorkDimensions;
}>;
/** Keep the original two-child Source planning envelope bounded by remaining frame balance. */
export declare function identitySourceConsumerDirectoryPlan(allowance: NativeStepWork): Readonly<{
    envelope: NativeStepWork;
    child: NativeStepWork;
}>;
/** Parse ceilings for independent Source work. These are never additive original
 * funding: the selected History route requires Accounts' private prepaid partition. */
export declare function readIdentitySourceMaintenanceConfig(env: Environment): IdentitySourceMaintenanceConfig;
/** Arithmetic for owner adoption only. This result cannot admit a Source callback,
 * authenticate an original, increase a child ceiling or create a private grant. */
export declare function composeIdentitySourceOriginalCosts(parts: Readonly<{
    accountsLocalControl: WorkDimensions | null;
    sourceHistoryNativeAllReachedCalls: WorkDimensions | null;
    libraryAllReachedCalls: WorkDimensions | null;
    additionalOriginalTransferControl: WorkDimensions | null;
}>): Readonly<{
    missing: readonly string[];
    total: WorkDimensions | null;
}>;
export type IdentitySourceReachedDeclaration = Readonly<{
    name: string;
    calls: number;
    declaration: Readonly<{
        work: WorkDimensions;
        engineRequests: 0;
    }> | null;
}>;
/** Assemble disjoint reached calls, including repeated validators and alternative
 * failure/rollback controls. This arithmetic never authenticates or funds a child.
 * Call counts come from the owning bounded body, not a caller's claimed progress. */
export declare function composeIdentitySourceReachedCosts(terms: readonly IdentitySourceReachedDeclaration[]): Readonly<{
    state: 'missing';
    missing: readonly string[];
}> | Readonly<{
    state: 'complete';
    work: WorkDimensions;
    engineRequests: 0;
}>;
export {};
