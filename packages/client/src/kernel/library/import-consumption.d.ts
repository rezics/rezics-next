import type { ProgressSessionJournal, ProgressSessionJournalDate, ProgressSessionJournalPatch, ProgressSessionJournalWrite } from './progress-model.ts';
import type { ProgressSessionJournalAdmission } from './sessions.ts';
export declare const IMPORT_CONSUMPTION_LIMITS: {
    readonly requestBytes: number;
    readonly rows: 20;
    readonly fields: 2;
    readonly resultBytes: number;
};
export type ImportDateField = 'startDate' | 'finishDate';
export type ImportDateAction = 'adopt' | 'clear';
export type ImportDateSourceState = 'missing' | 'unknown' | 'invalid' | 'unsupported' | 'value';
export type ImportDateSource = Readonly<{
    state: ImportDateSourceState;
    date: ProgressSessionJournalDate | null;
    precision: 'year' | 'month' | 'day' | null;
}>;
export type ImportDateFieldReview = Readonly<{
    field: ImportDateField;
    sourceState: ImportDateSourceState;
    precision: ImportDateSource['precision'];
    action: ImportDateAction | null;
    current: ProgressSessionJournalDate | null;
    proposed: ProgressSessionJournalDate | null;
    status: 'not-selected' | 'ready' | 'clear' | 'already-equal' | 'missing' | 'unknown' | 'invalid' | 'unsupported';
}>;
export type ImportDateSessionIdentity = Readonly<{
    sessionId: string;
    subjectId: string;
    versionSubjectId: string | null;
    startedAt: string;
    transactionId: string;
}>;
export type ImportConsumptionDateReview = Readonly<{
    version: string;
    sourceReviewToken: string;
    sourceFingerprint: string;
    matchFingerprint: string;
    subjectId: string;
    profileDigest: string;
    profileBinding: unknown;
    occurrenceProfileBinding: unknown;
    occurrence: ImportDateSessionIdentity;
    journalRevision: number;
    current: Readonly<{
        startDate: ProgressSessionJournalDate | null;
        finishDate: ProgressSessionJournalDate | null;
    }>;
    actions: Readonly<Partial<Record<ImportDateField, ImportDateAction>>>;
    fields: Readonly<Record<ImportDateField, ImportDateFieldReview>>;
}>;
export type ImportDateFieldOutcome = Readonly<{
    field: ImportDateField;
    status: 'applied' | 'cleared' | 'already-equal' | 'not-selected' | 'missing' | 'unknown' | 'invalid' | 'unsupported' | 'stale' | 'failed' | 'unattempted';
}>;
export type ImportConsumptionDateOutcome = Readonly<{
    version: string;
    status: 'applied' | 'skipped' | 'unsupported' | 'stale' | 'failed' | 'unattempted';
    fields: readonly ImportDateFieldOutcome[];
    receipt: ProgressSessionJournalWrite | null;
}>;
export type ImportConsumptionDateIntent = {
    version: string;
    fields: ImportDateField[];
    nativeRequestKey: string;
    patch: ProgressSessionJournalPatch | null;
    admissionIdentity: unknown;
    outcome?: ImportConsumptionDateOutcome;
};
/** Admit only the native Gregorian journal shape; parser-level validity is intentionally ignored. */
export declare function aniListDateSource(evidence: Record<string, unknown>, field: 'startedAt' | 'completedAt'): ImportDateSource;
/** VNDB's YYYY-00 and YYYY-MM-00 forms preserve the trailing unknown precision. */
export declare function vndbDateSource(value: {
    kind: string;
    raw: unknown;
} | undefined): ImportDateSource;
export declare function reviewImportConsumptionDates(input: {
    version: string;
    sourceReviewToken: string;
    sourceFingerprint: string;
    matchFingerprint: string;
    subjectId: string;
    profileDigest: string;
    profileBinding: unknown;
    occurrenceProfileBinding: unknown;
    occurrence: ImportDateSessionIdentity;
    journal: ProgressSessionJournal;
    start: ImportDateSource;
    finish: ImportDateSource;
    actions: Readonly<Partial<Record<ImportDateField, ImportDateAction>>>;
    profileCurrent: boolean;
}): ImportConsumptionDateReview;
export declare function publicImportConsumptionDateReview(review: ImportConsumptionDateReview): {
    version: string;
    sourceReviewToken: string;
    subjectId: string;
    occurrence: ImportDateSessionIdentity;
    journalRevision: number;
    current: Readonly<{
        startDate: ProgressSessionJournalDate | null;
        finishDate: ProgressSessionJournalDate | null;
    }>;
    actions: Readonly<Partial<Record<ImportDateField, ImportDateAction>>>;
    fields: Readonly<Record<ImportDateField, ImportDateFieldReview>>;
};
export declare function executeImportConsumptionDateIntent(input: {
    review: ImportConsumptionDateReview;
    fields: ImportDateField[];
    existing?: ImportConsumptionDateIntent;
    nativeRequestKey: string;
    admissionIdentity: unknown;
    admission: ProgressSessionJournalAdmission;
    isCurrent: () => Promise<boolean>;
    persist: (intent: ImportConsumptionDateIntent) => Promise<boolean>;
    patch: (sessionId: string, patch: ProgressSessionJournalPatch, requestKey: string, admission: ProgressSessionJournalAdmission) => Promise<{
        value: ProgressSessionJournalWrite;
    }>;
    record?: (value: unknown) => void;
    signal?: AbortSignal;
    isStaleError: (error: unknown) => boolean;
    rethrowError?: (error: unknown) => boolean;
}): Promise<ImportConsumptionDateIntent>;
export declare function applyImportConsumptionDateRows<T>(rows: readonly T[], signal: AbortSignal | undefined, apply: (row: T) => Promise<ImportConsumptionDateOutcome>, unattempted: (row: T) => ImportConsumptionDateOutcome, shouldStop?: () => boolean): Promise<{
    outcomes: ImportConsumptionDateOutcome[];
    complete: boolean;
}>;
