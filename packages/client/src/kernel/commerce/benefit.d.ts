import type { Pool } from 'pg';
import { AccessUnavailableError } from '../access/unavailable.ts';
import type { ContentEditionSaleAuthority } from '../content/edition-model.ts';
import { type ContentEditionConsentReader } from '../content/edition-sale.ts';
import type { ReadContext } from '../content/model.ts';
import type { Access } from '../request/access.ts';
import type { CapturedContentEdition, CapturedContentPost, CheckoutDecision } from './model.ts';
import type { ContentPostSaleAuthority } from '../content/post-benefit.ts';
export declare function ContentEditionUnavailableError(): {
    new (cause?: AccessUnavailableError): {
        name: string;
        message: string;
        stack?: string;
        cause?: unknown;
        readonly reason: 'deadline' | 'overloaded' | 'contention';
    };
    isError(error: unknown): error is Error;
    isError(value: unknown): value is Error;
    captureStackTrace(targetObject: object, constructorOpt?: Function): void;
    captureStackTrace(targetObject: object, constructorOpt?: Function): void;
    prepareStackTrace(err: Error, stackTraces: NodeJS.CallSite[]): any;
    stackTraceLimit: number;
};
export type ContentEditionUnavailableError = InstanceType<ReturnType<typeof ContentEditionUnavailableError>>;
export declare const MAX_CAPTURED_EDITION_BYTES = 4096;
export declare const MAX_CAPTURED_POST_BYTES = 4096;
/** Compatibility diagnostic for callers with no configured native dependencies.
 * Runtime admission uses the actual Content entrypoints below, never this diagnostic.
 */
export type NativeEditionAuthorityUnavailable = Readonly<{
    kind: 'unavailable';
    reason: 'content-edition-sale-port-pending';
}>;
export declare function nativeEditionAuthorityAvailability(): NativeEditionAuthorityUnavailable;
/** Auth-owned consent is an explicit operand of content sale reads; absent when Auth is unconfigured. */
export type SaleDependencies = Readonly<{
    pool: Pool;
    access: Access;
    clock: () => Date;
    readConsent?: ContentEditionConsentReader;
}>;
/** Translate only the closed native facts; this value is immutable terms, not permission. */
export declare function captureContentEditionSaleAuthority(editionId: string, authority: ContentEditionSaleAuthority | null): CapturedContentEdition;
/** Capture the stable Post/action promise without retaining a revision selector or body. */
export declare function captureContentPostSaleAuthority(postId: string, authority: ContentPostSaleAuthority | null, expectedTargetSubjectId?: string): CapturedContentPost;
/** Compare every immutable field, independently of serialized JSON property order. */
export declare function sameCapturedContentEdition(left: CapturedContentEdition | null | undefined, right: CapturedContentEdition | null | undefined): boolean;
export declare function sameCapturedContentPost(left: CapturedContentPost | null | undefined, right: CapturedContentPost | null | undefined): boolean;
/** Compare the immutable closed target union, including UNKNOWN/null preservation. */
export declare function sameCapturedContentBenefit(left: Readonly<{
    contentEdition?: CapturedContentEdition | null;
    contentPost?: CapturedContentPost | null;
}>, right: Readonly<{
    contentEdition?: CapturedContentEdition | null;
    contentPost?: CapturedContentPost | null;
}>): boolean;
/** Exhaustive current offer check for the closed Post/edition target union. */
export declare function requireCurrentCapturedContentBenefit(capture: Readonly<{
    contentEdition?: CapturedContentEdition | null;
    contentPost?: CapturedContentPost | null;
}>, dependencies: SaleDependencies, context: ReadContext): Promise<Readonly<{
    contentEdition?: CapturedContentEdition;
    contentPost?: CapturedContentPost;
}>>;
/** Settlement revalidates only native source availability; Access still guards every actual read. */
export declare function requireMechanicalCapturedContentBenefit(capture: Readonly<{
    contentEdition?: CapturedContentEdition | null;
    contentPost?: CapturedContentPost | null;
}>, dependencies: SaleDependencies, context: Readonly<{
    deadline: number;
}>): Promise<Readonly<{
    contentEdition?: CapturedContentEdition;
    contentPost?: CapturedContentPost;
}>>;
export declare function isContentEditionUnavailable(error: unknown): boolean;
/** Called on released command preparation, with the actual request Actor. */
export declare function captureCurrentContentEdition(editionId: string, dependencies?: SaleDependencies, context?: ReadContext): Promise<CapturedContentEdition>;
export declare function captureCurrentContentPost(postId: string, dependencies?: SaleDependencies, context?: ReadContext, targetSubjectId?: string): Promise<CapturedContentPost>;
export declare function requireCurrentContentEdition(capture: CapturedContentEdition | null | undefined, dependencies?: SaleDependencies, context?: ReadContext): Promise<CapturedContentEdition>;
export declare function requireCurrentContentPost(capture: CapturedContentPost | null | undefined, dependencies?: SaleDependencies, context?: ReadContext): Promise<CapturedContentPost>;
/** Trusted workflow reads have native buyer admission, never a fabricated buyer Actor. */
export declare function requireMechanicalContentEdition(capture: CapturedContentEdition | null | undefined, dependencies: SaleDependencies, context: Readonly<{
    deadline: number;
}>): Promise<CapturedContentEdition>;
export declare function requireMechanicalContentPost(capture: CapturedContentPost | null | undefined, dependencies: SaleDependencies, context: Readonly<{
    deadline: number;
}>): Promise<CapturedContentPost>;
/** Payment truth and revocation still apply when current target authority is missing.
 * A last-verified active entitlement stays active; absent/revoked ones cannot be restored.
 */
export declare function withoutUnverifiedBenefit(decision: CheckoutDecision): CheckoutDecision;
/** Validate persisted bytes without inferring identity from subject/title/provider data. */
export declare function decodeCapturedContentEdition(serialized: string | null): CapturedContentEdition | null;
export declare function encodeCapturedContentEdition(value: CapturedContentEdition | null | undefined): string | null;
/** Sale/history terms expose no source thread/post identity or revision body.
 * Content alone discloses its source metadata under current native authority.
 */
export declare function contentEditionTermsView(value: CapturedContentEdition | null | undefined): {
    source: {
        licence: string;
    };
    benefit: import("./model.ts").ContentEditionBenefit;
    creatorAccountId: string;
    targetSubjectId: string;
    saleTermsReference: string;
    delivery: 'fixed-content-edition';
    acquisition: 'one-time-account-bound';
    quantity: 1;
} | null;
/** Post terms expose the stable Post selector and the all-eligible-revisions promise only. */
export declare function contentPostTermsView(value: CapturedContentPost | null | undefined): {
    benefit: import("./model.ts").ContentPostBenefit;
    creatorAccountId: string;
    targetSubjectId: string;
    saleTermsReference: 'content-post-revisions-v1';
    delivery: 'eligible-post-revisions';
    acquisition: 'one-time-account-bound';
    quantity: 1;
} | null;
/** Validate persisted Post terms without deriving identity from subject/title/provider data. */
export declare function decodeCapturedContentPost(serialized: string | null): CapturedContentPost | null;
export declare function encodeCapturedContentPost(value: CapturedContentPost | null | undefined): string | null;
