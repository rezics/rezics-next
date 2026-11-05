import type { PersonalEntryFieldChange, PersonalEntry, PersonalEntryPrivacyValue, PersonalEntrySourceAdmission, PersonalEntrySourceCorrection, PersonalEntryTimestampInput } from './entry-personal-model.ts';
import type { Actor } from '../request/access.ts';
import type { CommandOutcome } from '../command/command.ts';
import { createEntryPersonalCommands } from './entry-personal.ts';
import type { LabelCommandAdmission } from './label-command-admission.ts';
export declare const ENTRY_IMPORT_METADATA_LIMITS: {
    readonly fields: 5;
    readonly reviewsPerRow: 2;
    readonly requestBytes: 2048;
    readonly reviewBytes: 32768;
    readonly rowBytes: 65536;
    readonly noteBytes: 4096;
    readonly privacyValueBytes: 192;
    readonly timestampBytes: 64;
    readonly responseBytes: 65536;
};
export type EntryImportMetadataField = 'note' | 'priority' | 'privacy' | 'sourceCreated' | 'sourceUpdated';
export type EntryImportMetadataProposal = Readonly<{
    state: 'value' | 'absent' | 'unknown' | 'empty' | 'invalid' | 'unsupported';
    sourceField: string | null;
    value?: string | number | PersonalEntryPrivacyValue | PersonalEntryTimestampInput;
    sourceValue?: string | number | boolean | null;
    mapping?: Readonly<{
        id: string;
        label: string;
    }>;
    reason?: string;
}>;
export type EntryImportMetadataProposals = Readonly<Record<EntryImportMetadataField, EntryImportMetadataProposal>>;
export type EntryImportMetadataSelection = Readonly<{
    field: EntryImportMetadataField;
    action: 'adopt' | 'clear';
    mapping?: string;
}>;
export type EntryImportMetadataFieldOutcome = Readonly<{
    field: EntryImportMetadataField;
    status: 'applied' | 'stale' | 'unsupported' | 'unattempted' | 'failed';
    reason?: string;
}>;
export type EntryImportMetadataOutcome = Readonly<{
    reviewToken: string;
    fields: readonly EntryImportMetadataFieldOutcome[];
}>;
export type EntryImportMetadataConfirmation = {
    nativeAdmission?: 'vndb-source-v1' | 'bangumi-source-v1';
    fields: EntryImportMetadataSelection[];
    selectionDigest: string;
    annotationKey: string;
    provenanceKey: string;
    annotationStarted: boolean;
    provenanceStarted: boolean;
    sourceExpired?: boolean;
    annotationReceiptDigest?: string;
    provenanceReceiptDigest?: string;
    provenanceKind?: 'admit' | 'correct';
    outcome?: EntryImportMetadataOutcome;
    annotationStatus?: 'applied' | 'stale' | 'unsupported' | 'unattempted';
    provenanceStatus?: 'applied' | 'stale' | 'unsupported' | 'unattempted';
    fieldOutcomes?: Array<Pick<EntryImportMetadataFieldOutcome, 'field' | 'status'>>;
    annotationInput?: {
        revision: number;
        note: PersonalEntryFieldChange<string>;
        priority: PersonalEntryFieldChange<number>;
        effect: boolean;
        expectedRevision: number;
        expectedNote: string | null;
        expectedPriority: number | null;
    };
    provenanceInput?: {
        kind: 'admit';
        value: PersonalEntrySourceAdmission;
        effect: true;
    } | {
        kind: 'correct';
        value: PersonalEntrySourceCorrection;
        effect: boolean;
    };
    sourceObservationDigest?: string;
};
export type EntryImportMetadataReview = {
    token: string;
    requestDigest: string;
    sourceReviewToken: string;
    subjectId: string;
    clientId: string;
    requestedBy: string | null;
    annotationRevision: number;
    personalDigest: string;
    sourceDigest: string;
    profileDigest: string;
    incarnationId: string | null;
    confirmation?: EntryImportMetadataConfirmation;
};
export type EntryImportMetadataView = Readonly<{
    status: 'current' | 'stale';
    reviewToken: string;
    sourceReviewToken: string;
    subjectId: string;
    personal: PersonalEntry;
    proposals: EntryImportMetadataProposals;
    outcome: EntryImportMetadataOutcome | null;
}>;
export declare function parseEntryImportMetadataSelections(value: unknown): EntryImportMetadataSelection[];
export declare function entryImportMetadataDigest(value: unknown): string;
export declare function entryPersonalMetadataDigest(personal: PersonalEntry): string;
export declare function metadataObservation(personal: PersonalEntry, provider: string, recordId: string): Readonly<{
    provider: string;
    recordId: string;
    revision: number;
    privacy: import("./entry-personal-model.ts").PrivacyFact;
    sourceCreated: import("./entry-personal-model.ts").TimestampFact;
    sourceUpdated: import("./entry-personal-model.ts").TimestampFact;
    recordedAt: string;
}> | null;
export declare function metadataValueState(value: EntryImportMetadataProposal): string;
export declare function assertEntryImportMetadataHistorySize(history: readonly EntryImportMetadataReview[]): void;
export declare function applyEntryImportMetadataCommands(input: {
    actor: Actor;
    subjectId: string;
    provider: string;
    recordId: string;
    reviewToken: string;
    personal: PersonalEntry;
    proposals: EntryImportMetadataProposals;
    selections: readonly EntryImportMetadataSelection[];
    baselineAnnotationRevision: number;
    confirmation: EntryImportMetadataConfirmation;
    native: ReturnType<typeof createEntryPersonalCommands>;
    persist: (confirmation: EntryImportMetadataConfirmation) => Promise<void>;
    record?: (outcome: CommandOutcome<unknown>) => void;
    isCancelled: () => Promise<boolean>;
    isCurrent?: () => Promise<boolean>;
    admission?: LabelCommandAdmission;
    readReceipt?: (phase: 'annotation' | 'provenance') => Promise<boolean>;
    signal?: AbortSignal;
}): Promise<{
    outcome: EntryImportMetadataOutcome;
    complete: boolean;
}>;
