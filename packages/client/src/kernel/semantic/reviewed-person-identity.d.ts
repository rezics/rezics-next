import type { Release } from '@rezics/definitions';
import type { CommandTransaction } from '../command/command.ts';
import type { NativeIdentityCapabilities, NativeReviewedPersonOperations } from './identity-adapter-port.ts';
import type { ReviewedPersonEndpoint, ReviewedPersonExpectation, ReviewedPersonSource } from './identity-adapters/identity-epoch-contract.ts';
export type { ReviewedPersonEndpoint, ReviewedPersonExpectation, ReviewedPersonSource };
export declare const ReviewedPersonEndpointSchema: import("typebox").TObject<{
    subject: import("typebox").TString;
    revision: import("typebox").TInteger;
    securityRevision: import("typebox").TString;
    source: import("typebox").TUnion<[import("typebox").TLiteral<"bangumi">, import("typebox").TLiteral<"vndb">, import("typebox").TLiteral<"bangumi_cross_media">, import("typebox").TLiteral<"vndb_cross_media">]>;
    externalId: import("typebox").TString;
    claimTransactionId: import("typebox").TString;
    property: import("typebox").TUnion<[import("typebox").TLiteral<"wdt:P6298">, import("typebox").TLiteral<"wdt:P3180">]>;
    value: import("typebox").TString;
}>;
export declare const ReviewedPersonExpectationSchema: import("typebox").TObject<{
    endpoints: import("typebox").TTuple<[import("typebox").TObject<{
        subject: import("typebox").TString;
        revision: import("typebox").TInteger;
        securityRevision: import("typebox").TString;
        source: import("typebox").TUnion<[import("typebox").TLiteral<"bangumi">, import("typebox").TLiteral<"vndb">, import("typebox").TLiteral<"bangumi_cross_media">, import("typebox").TLiteral<"vndb_cross_media">]>;
        externalId: import("typebox").TString;
        claimTransactionId: import("typebox").TString;
        property: import("typebox").TUnion<[import("typebox").TLiteral<"wdt:P6298">, import("typebox").TLiteral<"wdt:P3180">]>;
        value: import("typebox").TString;
    }>, import("typebox").TObject<{
        subject: import("typebox").TString;
        revision: import("typebox").TInteger;
        securityRevision: import("typebox").TString;
        source: import("typebox").TUnion<[import("typebox").TLiteral<"bangumi">, import("typebox").TLiteral<"vndb">, import("typebox").TLiteral<"bangumi_cross_media">, import("typebox").TLiteral<"vndb_cross_media">]>;
        externalId: import("typebox").TString;
        claimTransactionId: import("typebox").TString;
        property: import("typebox").TUnion<[import("typebox").TLiteral<"wdt:P6298">, import("typebox").TLiteral<"wdt:P3180">]>;
        value: import("typebox").TString;
    }>]>;
}>;
/** Cross-field validation at the public request boundary, before digesting the unchanged body. */
export declare function isReviewedPersonSource(value: ReviewedPersonSource): boolean;
export declare function reviewedPersonIdentifier(source: ReviewedPersonSource): {
    property: 'wdt:P6298';
    value: string;
} | {
    property: 'wdt:P3180';
    value: string;
};
export declare function validReviewedPersonExpectation(subjects: readonly string[], expected: ReviewedPersonExpectation): boolean;
/** Existing native unavailable classification, with a stable internal reason for unsupported coverage. */
export declare function ReviewedPersonGuardUnavailableError(): {
    new (partition: number): {
        readonly code: "atomic_guard_unavailable";
        name: string;
        message: string;
        stack?: string;
        cause?: unknown;
        readonly reason: 'fenced' | 'moved' | 'contention' | 'deadline' | 'overloaded';
        readonly partition: number;
        readonly movedTo: string | null;
    };
    isError(error: unknown): error is Error;
    isError(value: unknown): value is Error;
    captureStackTrace(targetObject: object, constructorOpt?: Function): void;
    captureStackTrace(targetObject: object, constructorOpt?: Function): void;
    prepareStackTrace(err: Error, stackTraces: NodeJS.CallSite[]): any;
    stackTraceLimit: number;
};
export type ReviewedPersonGuardUnavailableError = InstanceType<ReturnType<typeof ReviewedPersonGuardUnavailableError>>;
/** Reviewed Person observe/guard closed over one routing, slot and command set. */
export declare function createReviewedPersonOperations(capabilities: NativeIdentityCapabilities): NativeReviewedPersonOperations;
/** Caller has already authorized this original in its final read transaction. Never follows redirects. */
export declare function observeReviewedPersonIdentity(tx: CommandTransaction, subject: string, source: ReviewedPersonSource, routeKey: Uint8Array, release: Release, lockSelected?: boolean): Promise<ReviewedPersonEndpoint | null>;
/** Runs only inside the authorized first-effect callback; every restarted callback reacquires exclusions. */
export declare function guardReviewedPersonIdentity(tx: CommandTransaction, expected: ReviewedPersonExpectation, routeKey: Uint8Array, release: Release): Promise<void>;
