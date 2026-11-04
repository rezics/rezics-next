import { type ProblemCode } from './problem-error.ts';
export { PROBLEM_TYPE_BASE, PROBLEMS, ProblemError, type ProblemCode, type FieldErrorCode, type FieldError, } from './problem-error.ts';
export { issuePointers } from '@rezics/definitions/validate';
import type { TSchema } from 'typebox';
declare function schemaFor(codes: readonly ProblemCode[], status: number): import("typebox").TObject<{
    type: TSchema;
    title: TSchema;
    status: import("typebox").TLiteral<number>;
    code: TSchema;
    retryable: TSchema;
    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
    request_id: import("typebox").TString;
    detail?: import("typebox").TOptional<import("typebox").TString>;
    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
        pointer: import("typebox").TString;
        code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
    }>>>;
}>;
declare function extendedSchema<Extensions extends Record<string, TSchema>>(codes: readonly ProblemCode[], status: number, extensions: Extensions): import("typebox").TObject<{
    type: TSchema;
    title: TSchema;
    status: import("typebox").TLiteral<number>;
    code: TSchema;
    retryable: TSchema;
    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
    request_id: import("typebox").TString;
    detail?: import("typebox").TOptional<import("typebox").TString>;
    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
        pointer: import("typebox").TString;
        code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
    }>>>;
} & Omit<Extensions, "code" | "detail" | "effect_status" | "errors" | "instance" | "request_id" | "retryable" | "status" | "title" | "type">>;
declare function erasedResultSchema(): import("typebox").TObject<{
    type: TSchema;
    title: TSchema;
    status: import("typebox").TLiteral<number>;
    code: TSchema;
    retryable: TSchema;
    request_id: import("typebox").TString;
    detail?: import("typebox").TOptional<import("typebox").TString>;
    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
        pointer: import("typebox").TString;
        code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
    }>>>;
    effect_status: import("typebox").TLiteral<"applied">;
}>;
export declare function problemSchema(code: 'command_result_erased'): ReturnType<typeof erasedResultSchema>;
export declare function problemSchema<const Codes extends readonly [ProblemCode, ...ProblemCode[]]>(...codes: Codes): ReturnType<typeof schemaFor>;
export declare function problemSchema<const Codes extends readonly [ProblemCode, ...ProblemCode[]], const Extensions extends Record<string, TSchema>>(...codesAndExtensions: [...Codes, Extensions]): ReturnType<typeof extendedSchema<Extensions>>;
export declare function logInternalError(options: {
    requestId: string;
    method: string;
    route?: string | undefined;
    cause: unknown;
    commandIndex?: number | undefined;
}): void;
export declare function logDeadlineExceeded(context: {
    method: string;
    id: string;
    route?: string | undefined;
}): void;
export declare function problemResponse(error: unknown, context: {
    method: string;
    id: string;
    action?: string;
    route?: string | undefined;
}): Response;
