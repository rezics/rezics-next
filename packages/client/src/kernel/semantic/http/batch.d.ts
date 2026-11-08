import { PROBLEM_TYPE_BASE, type FieldError } from '../../http/problem.ts';
export declare const BULK_WRITE_ROUTE = "/v1/subjects:batchWrite";
declare const TRANSACTION_PHASES: readonly ['before_command', 'command_overhead', 'time_mint', 'access_prepare', 'gate_wait', 'transaction_pool_wait', 'transaction_body', 'commit', 'writable_wait', 'contention_pause', 'request_completion'];
export type BulkWriteTransactionPhase = (typeof TRANSACTION_PHASES)[number];
export type BulkWriteAction = 'subject:create' | 'statement:propose';
export type BulkWriteProblemBody = {
    type: string;
    title: string;
    status: number;
    code: string;
    retryable: boolean;
    effect_status: string;
    request_id: string;
    detail?: string;
    errors?: FieldError[];
    operation?: BulkWriteAction;
    partition?: number;
    phase?: BulkWriteTransactionPhase;
    contention_retries?: number;
    redirect?: {
        from: string;
        to: string;
    };
};
export declare function bulkWriteAction(op: string | undefined): BulkWriteAction;
export declare function bulkWriteUnavailableSchema(): import("typebox").TObject<{
    type: import("typebox").TSchema;
    title: import("typebox").TSchema;
    status: import("typebox").TLiteral<number>;
    code: import("typebox").TSchema;
    retryable: import("typebox").TSchema;
    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
    request_id: import("typebox").TString;
    detail?: import("typebox").TOptional<import("typebox").TString>;
    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
        pointer: import("typebox").TString;
        code: import("typebox").TUnion<import("typebox").TLiteral<import("../../http/problem-error.ts").FieldErrorCode>[]>;
    }>>>;
}>;
/** Safe RFC9457 extensions: operation, partition and transaction phase only. */
export declare function bulkWriteDiagnostics(error: unknown, action: BulkWriteAction): Pick<BulkWriteProblemBody, 'operation' | 'partition' | 'phase' | 'contention_retries'>;
export declare function logBulkWriteUnavailable(options: {
    requestId: string;
    action: BulkWriteAction;
    commandIndex: number;
    error: unknown;
    code: string;
}): void;
export declare function bulkWriteCommandProblem(error: unknown, options: {
    requestId: string;
    commandIndex: number;
    op: string | undefined;
}): Promise<{
    status: number;
    problem: BulkWriteProblemBody;
}>;
export declare function logPendingFenceFailure(requestId: string, commandIndex: number): Error;
export { PROBLEM_TYPE_BASE };
