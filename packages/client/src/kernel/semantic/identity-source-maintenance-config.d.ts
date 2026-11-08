import type { NativeStepWork } from './identity-epoch-contract.ts';
import type { WorkDimensions } from '../library/contract/work-dimensions.ts';
type Environment = Readonly<Record<string, string | undefined>>;
export { IDENTITY_SOURCE_ORIGINAL_SCHEDULE } from './contract/identity-source-schedule.ts';
export type { IdentitySourceLibraryOperation, IdentitySourceScheduledOperation, } from './contract/identity-source-schedule.ts';
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
/** Add already-classified Source declarations. This never invents an axis or
 * treats a five-field envelope as an implicit eight-axis child. */
export declare function sumIdentitySourceWork(parts: readonly Readonly<{
    work: WorkDimensions;
    engineRequests: 0;
}>[]): Readonly<{
    work: WorkDimensions;
    engineRequests: 0;
}>;
