import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import type { Access, Actor } from '../request/access.ts';
import { type PersonalEntry, type PersonalEntryObservation, type PrivacyFact, type TimestampFact } from './entry-personal-model.ts';
type Dependencies = {
    pool: Pool;
    access: Access;
    clock?: KernelClock;
};
export declare function createEntryPersonalCommands(dependencies: Dependencies): {
    readPersonalEntry: (actor: Actor, subjectId: string) => Promise<PersonalEntry>;
    saveAnnotations: (...args: Parameters<(actor: Actor, subjectId: string, input: unknown, requestKey: string) => Promise<import("../command/command.ts").CommandOutcome<Readonly<{
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
    admitSourceObservation: (...args: Parameters<(actor: Actor, subjectId: string, input: unknown, requestKey: string) => Promise<import("../command/command.ts").CommandOutcome<{
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
    correctSourceObservation: (...args: Parameters<(actor: Actor, subjectId: string, input: unknown, requestKey: string) => Promise<import("../command/command.ts").CommandOutcome<{
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
