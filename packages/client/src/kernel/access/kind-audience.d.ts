import type { AuthoritativeTime } from '../command/command.ts';
import type { CollectionKindPreparationLocator, CollectionKindWorkDefinition } from '../library/collection-kind-work-admission.ts';
import type { CollectionKindInputBinding } from '../library/collection-kind-input.ts';
import type { WorkAllowance, WorkDimensions, WorkReceipt } from '../library/collection-source.ts';
import type { AccessContext, AccountActor, Actor } from '../request/access.ts';
import type { CollectionKindPreparationWorkContext } from '../search/scope-work-context.ts';
import type { AccessWork, AccessWorkAccounting } from './work.ts';
/** SERVER ONLY. Every reference below is a native lookup key, never a principal,
 * cached decision, ordinary prepared Access evidence or proof of its own existence.
 * Resolve committed producer provenance on every use; JSON/casts cannot create it.
 */
export type KindAudienceOriginRef = Readonly<{
    kind: 'collection-kind-audience-origin';
    locator: CollectionKindPreparationLocator;
    id: string;
}>;
/** Accounts' enrollment of ONE Library-committed bounded raw input interval.
 * Library remains the sole input producer. This record must resolve that owner's
 * actual interval/predecessor/version/custody, including exclusions and duplicates;
 * it contains no caller-selected Subject keys.
 */
export type KindAudienceInputRef = Readonly<{
    kind: 'collection-kind-audience-input';
    locator: CollectionKindPreparationLocator;
    id: string;
}>;
export type KindAudienceEvidenceRef = Readonly<{
    kind: 'collection-kind-audience-evidence';
    locator: CollectionKindPreparationLocator;
    id: string;
}>;
/** Actual original Library declarations, resolved by the producer, not supplied
 * as an authority assertion by a worker. Includes exact release/audience,
 * Source identity/generation/observation, identity repair receipt and custody.
 */
export type KindAudienceBinding = Readonly<{
    locator: CollectionKindPreparationLocator;
    definition: CollectionKindWorkDefinition;
}>;
export type KindAudienceDependencyAxis = 'origin-and-current-formula' | 'negative-and-excluded' | 'temporal-transitions' | 'original-and-terminal-type-disclosure' | 'writer-before-visibility';
/** A key into native owner-backed enrollment, NOT caller-provided dependency
 * values. Accounts must resolve actual authentication lifetime/floor, account,
 * operator, assignment/principal, client/current consent/scopes, roles/memberships,
 * grants and ALL denials with the original formula. Semantic owns actual original
 * AND terminal Type/visibility/disclosure/identity/release/tuple dependencies.
 * Negative keys and future transitions require maintained coverage too.
 */
export type KindAudienceDependencyRef<A extends KindAudienceDependencyAxis> = Readonly<{
    kind: 'collection-kind-audience-dependency';
    axis: A;
    evidence: KindAudienceEvidenceRef;
    id: string;
}>;
/** All five native closures are mandatory. A timestamp, TTL, custody hold,
 * identity fence, repeated foreign read or relay acknowledgement cannot replace
 * writer-before-visibility enrollment and actual Source-local currentness.
 */
export type KindAudienceCoverage = Readonly<{
    formula: KindAudienceDependencyRef<'origin-and-current-formula'>;
    negatives: KindAudienceDependencyRef<'negative-and-excluded'>;
    temporal: KindAudienceDependencyRef<'temporal-transitions'>;
    typeDisclosure: KindAudienceDependencyRef<'original-and-terminal-type-disclosure'>;
    writers: KindAudienceDependencyRef<'writer-before-visibility'>;
}>;
/** Pure finite declarations for the SAME existing caller reservation. `source`
 * is the TOTAL across all eight Source axes, including the original Access bridge
 * exactly once; `access` attributes its six native axes, not an extra allowance.
 * Include admission, control/rollback, failure, final verification and cleanup.
 * Raw input <= original Kind raw100 and the full page/progress envelope <=4096
 * bytes, including excluded/duplicate/lookahead work. Unknown bounds return
 * undefined BEFORE any IO, never result-row estimates or fabricated zero work.
 */
export type KindAudienceWorkDeclaration = Readonly<{
    access: AccessWork;
    source: WorkDimensions;
}>;
/** Native producer only. `actual` consumes the exact invocation/result receipt
 * once; failures with no receipt burn the admitted bound in the existing ledger.
 * There is no caller permission callback or independently configurable evaluator.
 */
export type KindAudienceOperation<I, R extends Readonly<{
    work: WorkReceipt;
}>> = Readonly<{
    bound(input: I): KindAudienceWorkDeclaration | undefined;
    run(input: I): Promise<R>;
    actual(input: I, result: R): KindAudienceWorkDeclaration | undefined;
}>;
export type CaptureKindAudienceOriginInput = Readonly<{
    /** Only request capture takes Actor. Authenticated input must be the actual
     * original authenticator object, never standing/durable/approval restoration.
     * Anonymous input requires the actual native public floor and applicable
     * denials for this exact committed Source, never an account failure fallback.
     */
    actor: Actor;
    locator: CollectionKindPreparationLocator;
    context: AccessContext & Readonly<{
        time: AuthoritativeTime;
        work: AccessWorkAccounting;
    }>;
    allowance: WorkAllowance;
}>;
export type CaptureKindAudienceOriginResult = Readonly<{
    status: 'captured';
    origin: KindAudienceOriginRef;
    work: WorkReceipt;
}> | Readonly<{
    status: 'unavailable';
    reason?: string;
    work: WorkReceipt;
}>;
/** Source-local lookup AFTER Library commits the bounded input and BEFORE Type
 * completion. Read the original episode/interval/custody under native admission;
 * resolve Accounts' matching enrollment, without foreign IO or a completed-Type
 * prerequisite. Release this home before calling detached preparation.
 */
export type ResolveKindAudienceInput = Readonly<{
    work: CollectionKindPreparationWorkContext;
    origin: KindAudienceOriginRef;
    allowance: WorkAllowance;
    deadline: number;
    /** The same fresh original request that is being prepared; never persisted. */
    request?: KindAudienceFreshRequest;
}>;
export type ResolveKindAudienceResult = Readonly<{
    status: 'resolved';
    origin: KindAudienceOriginRef;
    input: KindAudienceInputRef;
    /** Pre-Type native input; deliberately independent of repair/Type closures. */
    binding: CollectionKindInputBinding;
    work: WorkReceipt;
}> | Readonly<{
    status: 'unavailable';
    reason?: string;
    work: WorkReceipt;
}>;
/**
 * One genuine request-scoped original Access invocation. This is deliberately
 * nested on the operation input: it is ephemeral evidence for the original
 * evaluator, never part of an origin/evidence reference or a native record.
 * Anonymous native work has no Actor field at all.
 */
export type KindAudienceFreshRequest = Readonly<{
    kind: 'authenticated';
    actor: AccountActor;
    context: AccessContext & Readonly<{
        work: AccessWorkAccounting;
    }>;
}> | Readonly<{
    kind: 'anonymous';
    context: AccessContext;
}>;
/** Request-local native orchestration. Authenticated quanta carry the genuine
 * original Access Actor and accounting only until this call returns; the root
 * Access factory verifies its private authentication identity before and after
 * dispatch. Anonymous work remains actor-free. Neither branch can carry an
 * Actor, JWT, claims, caller T or held Source transaction into retained state.
 * The native bodies resolve original committed origin/expiry/current
 * consent/client/basis and exact input custody. Each home requires ORIGINAL
 * Core admission and its OWN live T, with the SAME reservation. Release the
 * Source home before foreign preparation; an ended Source invocation/T cannot
 * be carried to another home.
 */
export type PrepareKindAudienceInput = Readonly<{
    origin: KindAudienceOriginRef;
    input: KindAudienceInputRef;
    context: Readonly<Pick<AccessContext, 'pool' | 'deadline'>>;
    allowance: WorkAllowance;
    /** The original Access root requires this for dispatch; pure native call graphs may omit it. */
    request?: KindAudienceFreshRequest;
}>;
export type PrepareKindAudienceResult = Readonly<{
    status: 'prepared';
    origin: KindAudienceOriginRef;
    input: KindAudienceInputRef;
    evidence: KindAudienceEvidenceRef;
    binding: KindAudienceBinding;
    coverage: KindAudienceCoverage;
    work: WorkReceipt;
}> | Readonly<{
    status: 'unavailable';
    reason?: string;
    work: WorkReceipt;
}>;
/** Final verification ONLY on the Source home under its live original Kind
 * admission and Source/episode/control locks. Derive T from commandTime(work.tx),
 * reread actual native currentness for ALL closures, and do no foreign IO.
 * Currentness must survive through local adoption/commit, including time expiry.
 */
export type VerifyKindAudienceSourceInput = Readonly<{
    work: CollectionKindPreparationWorkContext;
    evidence: KindAudienceEvidenceRef;
    allowance: WorkAllowance;
    deadline: number;
    /** Fresh original request for private formula revalidation; never persisted. */
    request?: KindAudienceFreshRequest;
}>;
export type VerifyKindAudienceSourceResult = Readonly<{
    status: 'current';
    origin: KindAudienceOriginRef;
    input: KindAudienceInputRef;
    evidence: KindAudienceEvidenceRef;
    binding: KindAudienceBinding;
    coverage: KindAudienceCoverage;
    /** This invocation's live T only, never a durable receipt or permission. */
    time: AuthoritativeTime;
    work: WorkReceipt;
}> | Readonly<{
    status: 'stale' | 'unavailable';
    reason?: string;
    work: WorkReceipt;
}>;
/** Purpose-bound extension of the ORIGINAL evaluator, never ordinary subject:read.
 * Retained refs/results cannot be used as Actor by authorize/prepare/read APIs.
 * A denied original cannot be rescued by a readable terminal; exclusions and
 * duplicates stay enrolled without exposing hidden Type/count/tie information.
 * Unknown never means exclusion, EOF or empty. Final viewer authorization and
 * exact audience selection remain independent; no public winner fallback.
 *
 * Native lookups use original admitted frames. Positive evidence remains unavailable
 * until Semantic supplies the committed repair receipt and all five current closures.
 */
export type KindAudienceAccess = Readonly<{
    capture: KindAudienceOperation<CaptureKindAudienceOriginInput, CaptureKindAudienceOriginResult>;
    resolveInput: KindAudienceOperation<ResolveKindAudienceInput, ResolveKindAudienceResult>;
    prepare: KindAudienceOperation<PrepareKindAudienceInput, PrepareKindAudienceResult>;
    verifySource: KindAudienceOperation<VerifyKindAudienceSourceInput, VerifyKindAudienceSourceResult>;
}>;
