import type { LibraryProgressUnitDescriptor } from './profile.ts';
/**
 * Pure rules for progress sessions. Commands own the account and the stored rows.
 * A reread is a new session; nothing here rewrites another one.
 */
export declare const MAX_COMPLETED_UNITS = 20000;
export declare const MAX_PROGRESS_MEASURES = 8;
export type ProgressMode = 'scalar_amount' | 'cursor_position' | 'completed_units';
export type ProgressUnit = string;
export type ProgressState = 'active' | 'completed' | 'abandoned';
export type ProgressAction = 'complete' | 'abandon';
export type ProgressSessionCreate = {
    subjectId: string;
    versionSubjectId: string | null;
    mode: ProgressMode;
    unit: ProgressUnit;
    total: string | null;
    additionalMeasures?: ProgressMeasureCreate[];
};
export type ProgressMeasureCreate = { unit: ProgressUnit; total: string | null };
export type ScalarRecord = {
    amount: string;
};
export type CursorRecord = {
    locator: string;
    position: string;
};
export type CompletedUnitsRecord = {
    add: readonly string[];
} | {
    remove: readonly string[];
} | {
    add: readonly string[];
    remove: readonly string[];
};
export type ProgressRecord = ScalarRecord | CursorRecord | CompletedUnitsRecord;
/** History payload. Unit ids are the ones given, sorted by code unit, never a filled range. */
export type ProgressIntent = {
    clear: true;
} | {
    measureId: string;
    clear: true;
} | {
    amount: string;
} | {
    measureId: string;
    amount: string;
} | {
    locator: string;
    position: string;
} | {
    add: string[];
} | {
    remove: string[];
} | {
    add: string[];
    remove: string[];
};
export type ProgressInvalid = {
    ok: false;
    field: string;
};
export type ProgressOutcome<T> = {
    ok: true;
    value: T;
} | ProgressInvalid;
/** Facts from the session a record is checked against. */
export type ProgressRecordContext = {
    unit: ProgressUnit;
    state: ProgressState;
};
/** Validate one new session. `total` belongs only to `scalar_amount` and is null when unknown. */
export declare function parseSessionCreate(input: unknown, descriptor?: LibraryProgressUnitDescriptor | 'syntax'): ProgressOutcome<ProgressSessionCreate>;
/** Validate one additional scalar measure admitted with a session. */
export declare function parseProgressMeasureCreate(input: unknown): ProgressOutcome<ProgressMeasureCreate>;
/**
 * Validate one record for `mode`. Only an active session records.
 * Legacy percent amounts stay within 0 to 100; profiled amounts use only declared bounds.
 */
export declare function parseRecord(mode: ProgressMode, input: unknown, context: ProgressRecordContext, descriptor?: LibraryProgressUnitDescriptor | 'syntax'): ProgressOutcome<ProgressRecord>;
/** Complete or abandon an active session. An amount, position, or unit count is not an action. */
export declare function transition(state: ProgressState, action: ProgressAction): ProgressOutcome<ProgressState>;
/** The history row for a validated record. Unit ids stay the given ids, in code-unit order. */
export declare function changeIntent(record: ProgressRecord, measureId?: string): ProgressIntent;
/**
 * Next sparse-set size. `added` is how many submitted ids were new.
 * `removed` is how many submitted ids already existed.
 */
export declare function nextUnitCount(current: number, added: number, removed: number): ProgressOutcome<number>;
