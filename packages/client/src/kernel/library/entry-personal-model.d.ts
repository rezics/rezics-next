export declare const MAX_PERSONAL_NOTE_BYTES = 4096;
export declare const MAX_PERSONAL_PRIORITY = 100;
export declare const MAX_SOURCE_OBSERVATIONS = 32;
export declare const MAX_SOURCE_TIMESTAMP_LENGTH = 64;
export declare const MAX_SOURCE_PRIVACY_VALUE_BYTES = 192;
export type FieldChange<T> = Readonly<{
    op: 'unchanged';
}> | Readonly<{
    op: 'clear';
}> | Readonly<{
    op: 'set';
    value: T;
}>;
export type PrivacyValue = Readonly<{
    status: 'absent';
}> | Readonly<{
    status: 'unknown';
    sourceValue?: string;
}> | Readonly<{
    status: 'known';
    meaning: 'private' | 'source_visible';
}>;
export type TimestampPrecision = 'year' | 'month' | 'day' | 'minute' | 'second' | 'fraction';
export type TimestampZone = 'utc' | 'offset' | 'unknown';
export type TimestampInput = Readonly<{
    status: 'absent';
}> | Readonly<{
    status: 'unknown';
    sourceValue?: string;
}> | Readonly<{
    status: 'known';
    value: string;
}>;
export type TimestampValue = Readonly<{
    status: 'absent';
}> | Readonly<{
    status: 'unknown';
    sourceValue?: string;
}> | Readonly<{
    status: 'known';
    value: string;
    precision: TimestampPrecision;
    zone: TimestampZone;
}>;
export type PrivacyFact = PrivacyValue | Readonly<{
    status: 'cleared';
}>;
export type TimestampFact = TimestampValue | Readonly<{
    status: 'cleared';
}>;
export type PersonalEntryObservation = Readonly<{
    provider: string;
    recordId: string;
    revision: number;
    privacy: PrivacyFact;
    sourceCreated: TimestampFact;
    sourceUpdated: TimestampFact;
    recordedAt: string;
}>;
export type PersonalEntry = Readonly<{
    subjectId: string;
    annotationRevision: number;
    note: string | null;
    priority: number | null;
    annotationUpdatedAt: string | null;
    sourceObservations: readonly PersonalEntryObservation[];
}>;
export type PersonalEntryProfileGuard = Readonly<{
    subjectId: string;
    identityEpoch: string;
    acceptingType: string;
    requestedSubjectId: string | null;
    component: Readonly<Record<string, unknown>>;
    pin: Readonly<Record<string, unknown>>;
}>;
export type PersonalEntryGuard = Readonly<{
    incarnationId: string;
    currentRevision: number;
    profileGuard?: PersonalEntryProfileGuard;
}>;
export type PersonalEntryFieldChange<T> = FieldChange<T>;
export type PersonalEntryPrivacyValue = PrivacyValue;
export type PersonalEntryPrivacy = PrivacyFact;
export type PersonalEntryTimestampValue = TimestampValue;
export type PersonalEntryTimestamp = TimestampFact;
export type PersonalEntryTimestampInput = TimestampInput;
export type PersonalEntryAnnotationWrite = Readonly<{
    revision: number;
    note: FieldChange<string>;
    priority: FieldChange<number>;
    /** Present only when a correction is bound to an existing entry incarnation. */
    entryGuard?: PersonalEntryGuard;
}>;
export type PersonalEntrySourceAdmission = Readonly<{
    provider: string;
    recordId: string;
    confirmReviewed: true;
    privacy: PrivacyValue;
    sourceCreated: TimestampInput;
    sourceUpdated: TimestampInput;
}>;
export type PersonalEntrySourceCorrection = Readonly<{
    provider: string;
    recordId: string;
    revision: number;
    confirmReviewed: true;
    privacy: FieldChange<PrivacyValue>;
    sourceCreated: FieldChange<TimestampInput>;
    sourceUpdated: FieldChange<TimestampInput>;
}>;
export declare function parsePersonalRevision(value: unknown, allowInitial?: boolean): number;
export declare function parsePersonalNote(value: unknown): string;
export declare function parsePersonalPriority(value: unknown): number;
export declare function parseFieldChange<T>(value: unknown, parse: (input: unknown) => T): FieldChange<T>;
export declare function applyFieldChange<T>(current: T | null, change: FieldChange<T>): T | null;
export declare function parseProviderKey(value: unknown): string;
export declare function parseProviderRecordId(value: unknown): string;
/** Preserve provider precision and offset exactly. Never parse through Date or normalize a source value. */
export declare function parseSourceTimestamp(value: unknown): Extract<TimestampValue, {
    status: 'known';
}>;
export declare function parsePrivacyValue(value: unknown): PrivacyValue;
export declare function parseTimestampValue(value: unknown): TimestampValue;
export declare function parsePrivacyChange(value: unknown): FieldChange<PrivacyValue>;
export declare function parseTimestampChange(value: unknown): FieldChange<TimestampValue>;
export declare function parseConfirmation(value: unknown): true;
export declare function factStatus<T extends {
    status: string;
}>(value: T | null): T | Readonly<{
    status: 'cleared';
}>;
