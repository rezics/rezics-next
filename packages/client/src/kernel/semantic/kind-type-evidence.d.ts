/** Private native Kind evidence. References are locators, never read authority. */
import type { Pool } from 'pg';
import type { Access } from '../request/access.ts';
import type { PrepareKindAudienceInput } from '../access/kind-audience.ts';
import type { CollectionKindWorkDefinition, CollectionKindPreparationLocator } from '../library/collection-kind-work-admission.ts';
import type { CanonicalDerivedRow, CanonicalGroupProgress } from '../library/canonical-source-store.ts';
import type { WorkAllowance, WorkDimensions, WorkReceipt } from '../library/collection-source.ts';
import { NativeCollectionWork } from '../library/collection-source-work.ts';
import type { CollectionKindPreparationWorkContext } from '../search/scope-work-context.ts';
import { type NativeKindTypeAnchor } from './scope-leaf-selection.ts';
/** One retained owner record in the existing Source home; possession grants nothing. */
export type KindTypeEvidenceReference = Readonly<{
    locator: CollectionKindPreparationLocator;
    evidenceId: string;
}>;
/** One original/group frontier; no subject vector, permission cache or second cursor. */
export type KindTypeEvidenceProgress = Readonly<{
    settledSubjectId: string | null;
    group: CanonicalGroupProgress | null;
}>;
export type KindTypeContribution = Readonly<{
    reference: CanonicalDerivedRow;
    typeId: string;
}>;
/** Accounts resolves these original lookup refs from Library's committed input
 * before detached preparation. They carry no admission or permission themselves.
 */
export type KindTypeEvidenceAudienceInput = Readonly<Pick<PrepareKindAudienceInput, 'origin' | 'input'>>;
export type KindTypeEvidenceReadInput = Readonly<{
    /** Library resolves its committed bounded attempt. No caller-supplied subjects. */
    locator: CollectionKindPreparationLocator;
    audience?: KindTypeEvidenceAudienceInput;
    allowance: WorkAllowance;
    deadline: number;
}>;
export type KindTypeEvidenceVerifyInput = Readonly<{
    work: CollectionKindPreparationWorkContext;
    evidence: KindTypeEvidenceReference;
    allowance: WorkAllowance;
    deadline: number;
}>;
export type KindTypeEvidenceUnavailable = Readonly<{
    status: 'unavailable';
    work: WorkReceipt;
}>;
export type KindTypeEvidenceReadResult = KindTypeEvidenceUnavailable | Readonly<{
    status: 'prepared';
    evidence: KindTypeEvidenceReference;
    progress: KindTypeEvidenceProgress;
    work: WorkReceipt;
}>;
export type KindTypeEvidenceVerifyResult = KindTypeEvidenceUnavailable | Readonly<{
    status: 'current';
    contributions: readonly KindTypeContribution[];
    progress: KindTypeEvidenceProgress;
    work: WorkReceipt;
}>;
export interface NativeKindTypeEvidence {
    /** Outside a Source transaction. Native producers must admit every home with its own live T. */
    read(input: KindTypeEvidenceReadInput): Promise<KindTypeEvidenceReadResult>;
    /** SAME Source only; no checkout, callback or foreign preparation inside this invocation. */
    verify(input: KindTypeEvidenceVerifyInput): Promise<KindTypeEvidenceVerifyResult>;
}
/** Native implementations still owed by the original owners. Accounts' literal
 * KindAudienceAccess is delivered; its staged factory supplies no admitted bound.
 */
export declare const KIND_TYPE_MISSING_OWNER_BINDINGS: readonly ["Library collection-kind-work-admission.ts: committed bounded attempt lookup, original reference/frontier, audience origin and finite admission work receipt", "Accounts access/kind-audience.ts and access/permission.ts: native bodies and finite bounds for KindAudienceAccess, with all five original formula/negative/temporal/Type-disclosure/writer closures", "Core command/operational.ts: no installed original admission-to-NativeCollectionWork association lookup or detached per-home Kind admission; liveness does not bind a ledger", "Library collection-kind-work-admission.ts: installed admit/read exports take only tx and locator, throw dependency_unavailable, and declare no bounded shared-ledger invocation"];
/** Public authority boundary. Missing original owner admission refuses before ANY IO.
 * The independent native bodies below supply no substitute permission or lifecycle.
 */
export declare function createNativeKindTypeEvidence(config: Readonly<{
    pool: Pool;
    access: Access;
}>): NativeKindTypeEvidence;
/** These native bodies consume the caller's EXISTING ledger and transaction.
 * They only produce/retain dependency data. In particular neither a successful
 * body write nor a local match is a prepared/current public evidence result.
 * Original admission, Accounts and whole-Kind closure remain separate operands.
 */
export declare const KIND_TYPE_BODY_MAX_BYTES = 16384;
export declare const KIND_TYPE_BINDING_MAX_BYTES = 16384;
export declare const KIND_TYPE_PROGRESS_MAX_BYTES = 4096;
export type KindTypeDisclosureProjection = 'readable' | 'denied';
export type NativeKindTypeDependencyBody = Readonly<{
    dependencies: KindTypeDependencyProjection;
    originalDisclosure: KindTypeDisclosureProjection;
    terminalDisclosure: KindTypeDisclosureProjection;
    releaseDigest: string;
}>;
/** Exact owner records are retained as data, not reinterpreted as admission.
 * The original producer must resolve these records, including its private
 * admission association, before it can promote a body to public evidence.
 */
export type NativeKindTypeBodyBinding = Readonly<{
    locator: CollectionKindPreparationLocator;
    audience: KindTypeEvidenceAudienceInput;
    definition: CollectionKindWorkDefinition;
}>;
export type NativeKindTypeRetainedBody = Readonly<{
    binding: NativeKindTypeBodyBinding;
    body: NativeKindTypeDependencyBody;
    progress: KindTypeEvidenceProgress;
}>;
/** Literal statement declarations only. Controls, owner admission/Access, Source
 * population/custody and the enclosing transaction are NOT included in this local
 * body quote. An unknown statement has no bound, including an empty seek.
 */
export declare function kindTypeEvidenceBodyFootprint(sql: string, values: readonly unknown[]): WorkDimensions | undefined;
/** Complete local worst case for one raw reference: original+terminal capture,
 * insert, immutable readback, final retained read and both final anchor checks.
 * Parameter bytes include each repeated SQL text and its actual encoded values.
 * This is deliberately NOT a whole-parent/transaction admission declaration.
 */
export declare function kindTypeEvidenceLocalFootprint(input: Readonly<{
    anchorInputBytes: number;
    lockInputBytes: number;
    writeValues: readonly unknown[];
    readValues: readonly unknown[];
}>): WorkDimensions;
/** Native data capture ONLY. Disclosure projections are decisions already made
 * by the original owner, never accepted by the public producer as authority.
 * Observe the original first, even when excluded, then retain the exact one-hop
 * terminal dependency. No terminal Type is read for an unreadable original.
 * No connection checkout, foreign home, new reservation or time is created here.
 */
export declare function captureNativeKindTypeDependency(pool: Pool, context: CollectionKindPreparationWorkContext, input: Readonly<{
    reference: CanonicalDerivedRow;
    originalDisclosure: KindTypeDisclosureProjection;
    terminalDisclosure: KindTypeDisclosureProjection;
    releaseDigest: string;
}>, work: NativeCollectionWork, deadline: number): Promise<NativeKindTypeDependencyBody>;
/** Immutable retained dependency registration. Its result is deliberately void:
 * a body registered here supplies no successful read, admission, custody or root
 * closure. The authentic original admission association is not installed on this
 * base, so the public producer cannot promote these raw records to evidence.
 * Collision readback must match EVERY byte of the episode/body/frontier data.
 */
export declare function retainNativeKindTypeDependencyBody(pool: Pool, context: CollectionKindPreparationWorkContext, reference: KindTypeEvidenceReference, value: NativeKindTypeRetainedBody, work: NativeCollectionWork, deadline: number): Promise<void>;
/** Durable native lookup. Compare against original owner data supplied by the
 * actual original resolver, not a restored definition/principal from this table.
 * The returned projection deliberately carries no admission/current status.
 */
export declare function readNativeKindTypeDependencyBody(pool: Pool, context: CollectionKindPreparationWorkContext, reference: KindTypeEvidenceReference, binding: NativeKindTypeBodyBinding, work: NativeCollectionWork, deadline: number): Promise<Readonly<{
    body: NativeKindTypeDependencyBody;
    progress: KindTypeEvidenceProgress;
    producerTransaction: string;
}> | null>;
/** Final SAME-home native data comparison. It retains the original AND terminal
 * writer locks in the caller's actual transaction until its commit/rollback.
 * It never opens another home or claims Accounts/Source/root authority. The
 * caller must separately verify the original admission association and all foreign
 * closures before exposing a public `current` result or adopting a contribution.
 */
export declare function compareNativeKindTypeDependencyBody(pool: Pool, context: CollectionKindPreparationWorkContext, reference: KindTypeEvidenceReference, expected: NativeKindTypeRetainedBody, work: NativeCollectionWork, deadline: number): Promise<KindTypeSelection | null>;
/** Internal structural dependencies. An excluded original is retained even when
 * it contributes nothing. These values deliberately cannot be passed to verify
 * as evidence: native records, original admissions and Accounts are still owed.
 */
export type KindTypeDependencyProjection = Readonly<{
    reference: CanonicalDerivedRow;
    original: NativeKindTypeAnchor;
    terminal: NativeKindTypeAnchor | null;
}>;
export type KindTypeSelection = Readonly<{
    state: 'unavailable';
    dependencies: KindTypeDependencyProjection;
}> | Readonly<{
    state: 'excluded';
    dependencies: KindTypeDependencyProjection;
}> | Readonly<{
    state: 'candidate';
    typeId: string;
    dependencies: KindTypeDependencyProjection;
}>;
/** Select only the native field dependency. This is NOT an audience decision or
 * vote, and the public producer never accepts a caller's projection as proof.
 * Library's existing terminal uniqueness/count CAS consumes admitted support,
 * so every duplicate raw reference remains a dependency without a seen vector.
 */
export declare function selectNativeKindTypeDependency(dependencies: KindTypeDependencyProjection): KindTypeSelection;
