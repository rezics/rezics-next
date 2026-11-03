import { type FilterDocument, type OwnerLeaf } from '@rezics/filter';
import type { Release } from '@rezics/definitions';
import type { Pool, PoolClient } from 'pg';
import { type AuthoritativeTime, type CommandAttempt } from '../command/command.ts';
import { type KernelClock } from '../clock.ts';
import { type Access, type Actor } from '../request/access.ts';
import type { RelationFacetMatch } from '../search/source.ts';
import { type CurrentNativeLeaf, type CurrentOwnerFilterPlan } from '../search/current-filter-plan.ts';
import type { LeafEvidence } from '../semantic/scope-leaf-evidence.ts';
import { type PrepareCollectionSource } from './collection-source.ts';
import { NativeCollectionWork } from './collection-source-work.ts';
import type { AdmittedCollectionRule } from './collection-rules.ts';
import { type LibraryProfilePin } from './profile.ts';
type EntryOperand = Extract<OwnerLeaf['owner'], {
    state: unknown;
}>['state'];
type NativeFactBase = {
    subjectId: string;
};
export type OwnerFilterEntryFact = NativeFactBase & {
    kind: 'entry';
    state: string;
    ownerWriteSeq: bigint | null;
    pin: LibraryProfilePin | null;
};
export type OwnerFilterNativeFact = OwnerFilterEntryFact | (NativeFactBase & {
    kind: 'label';
    labelId: string;
    assignmentId: string;
}) | (NativeFactBase & {
    kind: 'session';
    sessionId: string;
    lifecycle: 'active' | 'completed' | 'abandoned';
    mode: 'scalar_amount' | 'cursor_position' | 'completed_units';
    unit: string;
    pin: LibraryProfilePin | null;
}) | (NativeFactBase & {
    kind: 'holding';
    copyId: string;
    copyKind: string | null;
    status: string;
    pin: LibraryProfilePin | null;
});
/** Native keys discovered by the sole candidate/support producer, never an owner/account selector. */
export type OwnerFilterFactLocator = {
    kind: 'entry';
    subjectId: string;
} | {
    kind: 'label';
    subjectId: string;
    labelId: string;
} | {
    kind: 'session';
    subjectId: string;
    sessionId: string;
} | {
    kind: 'holding';
    subjectId: string;
    copyId: string;
};
export interface OwnerFilterLeafProvider {
    /** One current supporter, independent of profile/pin readiness; false is not canonical absence. */
    readPresence(client: Pick<PoolClient, 'query'>, locator: OwnerFilterFactLocator, work: NativeCollectionWork): Promise<boolean>;
    /**
     * Exact native point only. The caller supplies its source-authorized snapshot and SAME shared Source ledger.
     * A miss is NOT complete canonical absence; original/terminal disclosure and complete support remain required.
     * No history/alias enumeration, readiness, Source observation or permission is supplied by this provider.
     */
    read(client: Pick<PoolClient, 'query'>, locator: OwnerFilterFactLocator, work: NativeCollectionWork): Promise<OwnerFilterNativeFact | null>;
}
export type CollectionMemberAdmission = {
    filter: FilterDocument | undefined;
    sort: 'id';
    plan: CurrentOwnerFilterPlan | null;
    /** Immutable admitted meaning and exact expanded query; private cursor/preparation input, never permission. */
    releaseDigest: string | null;
    release: Release | null;
    queryDigest: string;
    /** Bound only after every expanded private-family branch has passed current viewer-self admission. */
    owner: OwnerFilterLeafProvider | null;
};
/** Native point implementation only. Callers must independently admit the owner and complete original closure. */
export declare function leafProvider(accountId: string, filter: FilterDocument, deadline: number): OwnerFilterLeafProvider;
export declare function matchOwnerFilterSupport(leaf: Exclude<OwnerLeaf['owner'], {
    state: unknown;
}>, fact: OwnerFilterNativeFact, releases: ReadonlyMap<string, Release>): RelationFacetMatch;
/**
 * Fold already settled LIVE native entry points before testing any requested state. Bounded source work owns
 * enumeration/completeness. Unsequenced entries cannot lose to a sequenced entry by an invented tie-breaker.
 */
export declare function ownerFilterStateWinner(entries: Iterable<OwnerFilterEntryFact>): OwnerFilterEntryFact | null | 'not_proven';
/** Null is usable only after the shared Source establishes complete no-entry evidence. */
export declare function matchOwnerFilterState(leaf: EntryOperand, winner: ReturnType<typeof ownerFilterStateWinner>, releases: ReadonlyMap<string, Release>): RelationFacetMatch;
/**
 * Consume the existing Semantic leaf evidence for the EXACT requested catalogue leaf. Current Source,
 * original/terminal disclosure and identity observations belong to the caller, independently of this matcher.
 * A selected positive can suffice; a partial selection can never manufacture absence beneath NOT.
 */
export declare function matchOwnerFilterCatalogue(leaf: Extract<CurrentNativeLeaf, {
    kind: 'catalogue';
}>, evidence: LeafEvidence): RelationFacetMatch;
/** Resolve/admit ALL deduplicated leaves before invoking Search's sole Boolean interpreter. */
export declare function evaluateOwnerFilterLeaves(plan: CurrentOwnerFilterPlan, observations: ReadonlyMap<string, RelationFacetMatch>): RelationFacetMatch;
export type CollectionMemberQuery = {
    cursor?: string | null;
    limit?: number;
    filter?: string;
    sort?: string;
    view?: 'BASIC' | 'FULL';
};
type Dependencies = {
    pool: Pool;
    access: Access;
    clock?: KernelClock;
};
/** Exact native grammar/family admission, not a permission verdict or a serializable capability.
 * Consumers must repeat ordinary current authority and Source/identity fences at their actual T.
 */
export declare function readNativeCollectionMemberAdmission(admission: CollectionMemberAdmission): Readonly<{
    actor: Actor;
    pool: Pool;
    deadline: number;
    retainedMeaning: boolean;
}> | undefined;
/** Repeat the admitted expanded families at the actual caller time, including every negative branch. */
export declare function prepareNativeCollectionMemberAuthority(deps: Dependencies, viewer: Actor, admission: CollectionMemberAdmission, at: AuthoritativeTime, deadline: number, attempt?: CommandAttempt): Promise<import("../request/access.ts").AccessCheck[]>;
/** Shared grammar/release admission only. The returned AST certifies neither execution nor disclosure. */
export declare function admitCollectionMemberQuery(deps: Dependencies, viewer: Actor, options: CollectionMemberQuery, deadline: number): Promise<CollectionMemberAdmission>;
/** Stored expanded meaning keeps its accepted release; it is never reinterpreted by current activation. */
export declare function admitSavedCollectionMemberQuery(deps: Dependencies, viewer: Actor, rule: AdmittedCollectionRule, options: CollectionMemberQuery, deadline: number): Promise<CollectionMemberAdmission>;
/**
 * Native common-member/saved-rule composition boundary. The enclosing caller supplies its EXISTING Source
 * context and reserved allowance. Only the real Source producer can return its opaque authorized handle.
 * No private fact SQL, raw-window fallback, fabricated handle, readiness or additional allowance is supplied.
 */
export declare function prepareCollectionMemberFilter(deps: Dependencies, options: CollectionMemberQuery, input: PrepareCollectionSource): Promise<{
    admission: CollectionMemberAdmission;
    source: import("./collection-source.ts").PreparedCollectionSource;
    work: import("./collection-source.ts").WorkReceipt;
}>;
export {};
