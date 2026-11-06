import type { Pool } from 'pg';
import { AccessUnavailableError } from '../access/unavailable.ts';
import type { ContentEditionSaleAuthority } from '../content/edition-model.ts';
import type { ReadContext } from '../content/model.ts';
import type { Access } from '../request/access.ts';
import type { CapturedContentEdition, CheckoutDecision } from './model.ts';
export declare function ContentEditionUnavailableError(): {
    new (cause?: AccessUnavailableError): {
        cause?: unknown;
        name: string;
        message: string;
        stack?: string;
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
/** Compatibility diagnostic for callers with no configured native dependencies.
 * Runtime admission uses the actual Content entrypoints below, never this diagnostic.
 */
export type NativeEditionAuthorityUnavailable = Readonly<{
    kind: 'unavailable';
    reason: 'content-edition-sale-port-pending';
}>;
export declare function nativeEditionAuthorityAvailability(): NativeEditionAuthorityUnavailable;
type SaleDependencies = Readonly<{
    pool: Pool;
    access: Access;
    clock?: () => Date;
}>;
/** Translate only the closed native facts; this value is immutable terms, not permission. */
export declare function captureContentEditionSaleAuthority(editionId: string, authority: ContentEditionSaleAuthority | null): CapturedContentEdition;
/** Compare every immutable field, independently of serialized JSON property order. */
export declare function sameCapturedContentEdition(left: CapturedContentEdition | null | undefined, right: CapturedContentEdition | null | undefined): boolean;
export declare function isContentEditionUnavailable(error: unknown): boolean;
/** Called on released command preparation, with the actual request Actor. */
export declare function captureCurrentContentEdition(editionId: string, dependencies?: SaleDependencies, context?: ReadContext): Promise<CapturedContentEdition>;
export declare function requireCurrentContentEdition(capture: CapturedContentEdition | null | undefined, dependencies?: SaleDependencies, context?: ReadContext): Promise<CapturedContentEdition>;
/** Trusted workflow reads have native buyer admission, never a fabricated buyer Actor. */
export declare function requireMechanicalContentEdition(capture: CapturedContentEdition | null | undefined, dependencies: SaleDependencies, context: Readonly<{
    deadline: number;
}>): Promise<CapturedContentEdition>;
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
export {};
