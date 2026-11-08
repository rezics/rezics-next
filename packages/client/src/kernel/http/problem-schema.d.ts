import type { TSchema } from 'typebox';
import { type ProblemCode, type FieldErrorCode } from './problem-error.ts';
export declare function fieldErrorCodes(): readonly FieldErrorCode[];
declare const reservedMembers: {
    readonly type: true;
    readonly title: true;
    readonly status: true;
    readonly detail: true;
    readonly instance: true;
    readonly errors: true;
    readonly code: true;
    readonly retryable: true;
    readonly effect_status: true;
    readonly request_id: true;
};
export declare function extensionMembers<T extends Readonly<Record<string, unknown>>>(extensions: T): Omit<T, keyof typeof reservedMembers>;
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
        code: import("typebox").TUnion<import("typebox").TLiteral<FieldErrorCode>[]>;
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
        code: import("typebox").TUnion<import("typebox").TLiteral<FieldErrorCode>[]>;
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
        code: import("typebox").TUnion<import("typebox").TLiteral<FieldErrorCode>[]>;
    }>>>;
    effect_status: import("typebox").TLiteral<"applied">;
}>;
export declare function problemSchema(code: 'command_result_erased'): ReturnType<typeof erasedResultSchema>;
export declare function problemSchema<const Codes extends readonly [ProblemCode, ...ProblemCode[]]>(...codes: Codes): ReturnType<typeof schemaFor>;
export declare function problemSchema<const Codes extends readonly [ProblemCode, ...ProblemCode[]], const Extensions extends Record<string, TSchema>>(...codesAndExtensions: [...Codes, Extensions]): ReturnType<typeof extendedSchema<Extensions>>;
export {};
