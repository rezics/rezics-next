import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import { type CommandTransaction } from '../command/command.ts';
import type { LabelCommandAdmission } from './label-command-admission.ts';
import type { Access, Actor } from '../request/access.ts';
import { type PersonalEntry, type PersonalEntryObservation, type PrivacyFact, type TimestampFact, type TimestampValue } from './entry-personal-model.ts';
type Dependencies = {
    pool: Pool;
    access: Access;
    clock?: KernelClock;
};
export declare function entryPersonalAnnotationRequestInput(subjectId: string, input: unknown, admissionInput?: unknown): {
    subjectId: string;
    importAdmission?: {} | null;
    revision: number;
    note: import("./entry-personal-model.ts").FieldChange<string>;
    priority: import("./entry-personal-model.ts").FieldChange<number>;
    entryGuard?: {
        incarnationId: string;
        currentRevision: number;
        reviewGuard?: {
            reviewId: string;
            epoch: string;
            position: number;
        };
        profileGuard?: {
            subjectId: string;
            identityEpoch: string;
            acceptingType: string;
            requestedSubjectId: string | null;
            component: Record<string, unknown>;
            pin: Record<string, unknown>;
        };
    };
};
export declare function entryPersonalSourceObservationRequestInput(kind: 'admit' | 'correct', subjectId: string, input: unknown, admissionInput?: unknown): {
    subjectId: string;
    importAdmission?: {} | null;
    provider: string;
    recordId: string;
    confirmReviewed: true;
    privacy: {
        status: 'cleared';
    } | import("./entry-personal-model.ts").PrivacyValue;
    sourceCreated: {
        status: 'cleared';
    } | TimestampValue;
    sourceUpdated: {
        status: 'cleared';
    } | TimestampValue;
} | {
    subjectId: string;
    importAdmission?: {} | null;
    provider: string;
    recordId: string;
    revision: number;
    confirmReviewed: true;
    privacy: import("./entry-personal-model.ts").FieldChange<import("./entry-personal-model.ts").PrivacyValue>;
    sourceCreated: import("./entry-personal-model.ts").FieldChange<TimestampValue>;
    sourceUpdated: import("./entry-personal-model.ts").FieldChange<TimestampValue>;
};
export declare function createEntryPersonalCommands(dependencies: Dependencies): {
    receiptDigest: (actor: Actor, kind: string, input: unknown) => string;
    readCommandReceipt: (actor: Actor, request: {
        kind: string;
        requestKey: string;
        digest: string;
        authorize: (tx: CommandTransaction) => Promise<void>;
    }) => Promise<import("../command/command.ts").CommandOutcome<unknown> | null>;
    readPersonalEntry: (actor: Actor, subjectId: string) => Promise<PersonalEntry>;
    readSourceObservation: (...args: Parameters<(actor: Actor, subjectId: string, provider: string, recordId: string) => Promise<PersonalEntryObservation | null>>) => Promise<Readonly<{
        provider: string;
        recordId: string;
        revision: number;
        privacy: PrivacyFact;
        sourceCreated: TimestampFact;
        sourceUpdated: TimestampFact;
        recordedAt: string;
    }> | null>;
    saveAnnotations: (...args: Parameters<(actor: Actor, subjectId: string, input: unknown, requestKey: string, admission?: LabelCommandAdmission) => Promise<import("../command/command.ts").CommandOutcome<Readonly<{
        subjectId: string;
        annotationRevision: number;
        note: string | null;
        priority: number | null;
        annotationUpdatedAt: string | null;
        sourceObservations: readonly PersonalEntryObservation[];
    }>>>>) => Promise<import("../command/command.ts").CommandOutcome<Readonly<{
        subjectId: string;
        annotationRevision: number;
        note: string | null;
        priority: number | null;
        annotationUpdatedAt: string | null;
        sourceObservations: readonly PersonalEntryObservation[];
    }>>>;
    admitSourceObservation: (...args: Parameters<(actor: Actor, subjectId: string, input: unknown, requestKey: string, internalGuard?: unknown, admission?: LabelCommandAdmission) => Promise<import("../command/command.ts").CommandOutcome<{
        sourceObservation: Readonly<{
            provider: string;
            recordId: string;
            revision: number;
            privacy: PrivacyFact;
            sourceCreated: TimestampFact;
            sourceUpdated: TimestampFact;
            recordedAt: string;
        }>;
    }>>>) => Promise<import("../command/command.ts").CommandOutcome<{
        sourceObservation: Readonly<{
            provider: string;
            recordId: string;
            revision: number;
            privacy: PrivacyFact;
            sourceCreated: TimestampFact;
            sourceUpdated: TimestampFact;
            recordedAt: string;
        }>;
    }>>;
    correctSourceObservation: (...args: Parameters<(actor: Actor, subjectId: string, input: unknown, requestKey: string, internalGuard?: unknown, admission?: LabelCommandAdmission) => Promise<import("../command/command.ts").CommandOutcome<{
        sourceObservation: Readonly<{
            provider: string;
            recordId: string;
            revision: number;
            privacy: PrivacyFact;
            sourceCreated: TimestampFact;
            sourceUpdated: TimestampFact;
            recordedAt: string;
        }>;
    }>>>) => Promise<import("../command/command.ts").CommandOutcome<{
        sourceObservation: Readonly<{
            provider: string;
            recordId: string;
            revision: number;
            privacy: PrivacyFact;
            sourceCreated: TimestampFact;
            sourceUpdated: TimestampFact;
            recordedAt: string;
        }>;
    }>>;
};
export {};
