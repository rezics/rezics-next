import type { Release } from '@rezics/definitions';
import type { Pool } from 'pg';
import type { Access } from '../request/access.ts';
import type { CollectionPublicationWorkDefinition } from '../library/collection-publication-work-admission.ts';
import type { NativeOrdinalKey } from '../library/contract/index.ts';
import type { CollectionMemberAdmission } from '../library/owner-filter.ts';
import type { IdentityScopeObservation } from '../semantic/identity-scope-types.ts';
import type { CurrentOwnerFilterPlan } from './current-filter-plan.ts';
import { type CollectionPublicationWorkContext, type MembersPreparationWorkContext } from './scope-work-context.ts';
import { type ScopeWork } from './scope-work.ts';
import type { ScopeEvaluationProgress } from './scope-source.ts';
import type { MembersPreparationWorkDefinition, SearchLibraryScopePort, SearchNativeCollectionWork } from './library-scope-port.ts';
export type MembersWorkInput = Readonly<{
    pool: Pool;
    access: Access;
    deadline: number;
    work: MembersPreparationWorkContext | CollectionPublicationWorkContext;
    library: SearchLibraryScopePort;
}>;
export type MembersSnapshot = Readonly<{
    native: MembersPreparationWorkDefinition | CollectionPublicationWorkDefinition;
    source: Awaited<ReturnType<SearchLibraryScopePort['source']['readWorkState']>>;
    observation: IdentityScopeObservation;
    ownerFence: string | null;
}>;
type RawKey = {
    original: string;
    driver: number;
    fact: string;
};
type Group = {
    keys: RawKey[];
    complete: boolean;
};
export type MembersExecution = {
    input: MembersWorkInput;
    snapshot: MembersSnapshot;
    admission: CollectionMemberAdmission;
    groups: Map<string, Group>;
};
/** Transfer one remaining original allowance. Failures expose the cumulative Search receipt too. */
export declare function runMembersWork<T>(input: MembersWorkInput, work: ScopeWork, body: (native: SearchNativeCollectionWork) => Promise<T>): Promise<T>;
/** The native source reader checks the complete canonical basis, metadata and immutable definition.
 * Read the actual capture/revision at that exact source fence; Collection observations are never cast to Scope70. */
export declare function readMembersSnapshot(input: MembersWorkInput, work: SearchNativeCollectionWork): Promise<MembersSnapshot>;
export declare function revalidateMembersObservation(input: MembersWorkInput, observation: IdentityScopeObservation, work: SearchNativeCollectionWork): Promise<void>;
export declare function sameMembersSnapshot(expected: MembersSnapshot, actual: MembersSnapshot): boolean;
export declare function membersRelease(input: MembersWorkInput, work: SearchNativeCollectionWork, digest: string): Promise<Release | null>;
export declare function membersExecution(input: MembersWorkInput, snapshot: MembersSnapshot, plan: CurrentOwnerFilterPlan, queryDigest: string, release: Release): MembersExecution;
/** Indexed local directory of the actual READY capture. No foreign identity home is opened here.
 * Its native enrollment recorded the original's real control group; Scope70 checks fence changes. */
export declare function membersTerminal(execution: MembersExecution, original: string, work: SearchNativeCollectionWork): Promise<string | null>;
export declare function membersProgress(execution: MembersExecution, subject: string, basis: string): ScopeEvaluationProgress;
/** Same Library matcher, native owner point provider and Boolean plan as ordinary Members. */
export declare function evaluateMembersSubject(execution: MembersExecution, subject: string, work: ScopeWork): Promise<import("./source.ts").RelationFacetMatch>;
/** DISTINCT uses the earliest live native occurrence across the complete canonical group, independent of
 * the caller's output frontier. It therefore needs neither a pooled retained Search table nor an unbounded seen set. */
export declare function firstMembersOrdinal(execution: MembersExecution, subject: string, work: SearchNativeCollectionWork): Promise<NativeOrdinalKey | null>;
export {};
