/** Private native Kind evidence. References are locators, never read authority. */
import type { Pool } from 'pg';
import type { Access } from '../request/access.ts';
import type { PrepareKindAudienceInput } from '../access/kind-audience.ts';
import type { CollectionKindPreparationLocator } from '../library/collection-kind-work-admission.ts';
import type { CanonicalDerivedRow, CanonicalGroupProgress } from '../library/canonical-source-store.ts';
import type { WorkAllowance, WorkReceipt } from '../library/collection-source.ts';
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
export declare const KIND_TYPE_MISSING_OWNER_BINDINGS: readonly ["Library collection-kind-work-admission.ts: committed bounded attempt lookup, original reference/frontier, audience origin and finite admission work receipt", "Accounts access/kind-audience.ts and access/permission.ts: native bodies and finite bounds for KindAudienceAccess, with all five original formula/negative/temporal/Type-disclosure/writer closures", "Core command/operational.ts: original per-home Kind attempt admission with a genuine live T and the SAME Source reservation, without a held Source transaction"];
/** Literal-first boundary. Missing original owner admission refuses before ANY IO.
 * Native selection/reduction below supplies no substitute permission or lifecycle.
 */
export declare function createNativeKindTypeEvidence(config: Readonly<{
    pool: Pool;
    access: Access;
}>): NativeKindTypeEvidence;
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
