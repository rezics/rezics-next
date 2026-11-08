import type { CopyConditionValue, CopyConditionField, CopyConditionPatch, CopyInput, CopyPatch } from '../contract/index.ts';
export declare class CopyConditionInvalidError extends Error {
    readonly field: CopyConditionField;
    constructor(field: CopyConditionField);
}
export declare function isCopyConditionValue(value: unknown): value is CopyConditionValue;
/** Merge this result into the existing complete command input before hashing it.
 * Missing fields stay missing, so old receipts retain their original operands.
 */
export declare function parseCopyConditionFields(input: Readonly<Record<string, unknown>>): CopyConditionPatch;
export declare function plain(value: unknown): Record<string, unknown>;
export declare function unexpected(value: Record<string, unknown>, allowed: readonly string[]): string | null;
export declare function subjectId(value: unknown): string;
export declare function vocabularyValue(value: unknown, field: string): string;
export declare function revisionValue(value: unknown): number;
export declare function parseCreate(input: unknown): CopyInput;
export declare function parseUpdate(input: unknown): CopyPatch;
export declare function parseCopyRestore(copyId: string, input: unknown): {
    copyId: string;
    deletionId: string;
    revision: number;
};
