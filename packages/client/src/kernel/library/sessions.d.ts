import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import { type CommandTransaction } from '../command/command.ts';
import { type Access, type Actor } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { ProgressMeasurePresentation, ProgressPresentation, ProgressSession, ProgressSessionJournalDate } from './progress-model.ts';
import type { LibraryProfilePin } from './profile.ts';
type Dependencies = {
    pool: Pool;
    access: Access;
    tokens: KeyRing;
    clock?: KernelClock;
};
type Page = {
    limit?: number;
    cursor?: string;
};
export type ProgressSessionJournalAdmission = {
    identity: unknown;
    assert: (tx: CommandTransaction) => Promise<void>;
};
type ExpectedProgressBinding = {
    subjectId: string;
    requestedSubjectId: string | null;
    acceptingType: string;
    identityEpoch: string;
    component: {
        partition: number;
        epoch: number;
        position: string;
    };
    profilePin: Extract<LibraryProfilePin, {
        provenance: 'profile';
    }>;
};
export declare class ProgressInvalidError extends Error {
    readonly field: string;
    constructor(field: string);
}
export declare class ProgressConflictError extends Error {
    constructor();
}
/** Private progress commands and snapshot/keyset reads on the owning account's partition. */
export declare function createSessionCommands(config: Dependencies): {
    startSession: (actor: Actor, input: unknown, requestKey: string, expected?: ExpectedProgressBinding) => Promise<import("../command/command.ts").CommandOutcome<ProgressSession>>;
    recordProgress: (actor: Actor, sessionId: string, input: unknown, requestKey: string, expected?: ExpectedProgressBinding) => Promise<import("../command/command.ts").CommandOutcome<ProgressSession>>;
    completeSession: (actor: Actor, sessionId: string, input: unknown, requestKey: string, expected?: ExpectedProgressBinding) => Promise<import("../command/command.ts").CommandOutcome<ProgressSession>>;
    abandonSession: (actor: Actor, sessionId: string, input: unknown, requestKey: string, expected?: ExpectedProgressBinding) => Promise<import("../command/command.ts").CommandOutcome<ProgressSession>>;
    reopenSession: (actor: Actor, sessionId: string, input: unknown, requestKey: string) => Promise<import("../command/command.ts").CommandOutcome<ProgressSession>>;
    retireSession: (actor: Actor, sessionId: string, input: unknown, requestKey: string) => Promise<import("../command/command.ts").CommandOutcome<ProgressSession>>;
    readSession: (actor: Actor, sessionId: string) => Promise<ProgressSession>;
    inspectSession: (actor: Actor, sessionId: string) => Promise<{
        session: ProgressSession;
        pin: LibraryProfilePin | null;
    }>;
    readSessionJournal: (actor: Actor, sessionId: string) => Promise<Readonly<{
        sessionId: string;
        revision: number;
        startDate: ProgressSessionJournalDate | null;
        finishDate: ProgressSessionJournalDate | null;
        reflection: string | null;
        assessment: import("./progress-model.ts").ProgressSessionJournalAssessment;
    }>>;
    patchSessionJournal: (actor: Actor, sessionId: string, input: unknown, requestKey: string, admission?: ProgressSessionJournalAdmission) => Promise<import("../command/command.ts").CommandOutcome<{
        sessionId: string;
        revision: number;
        changed: boolean;
    }>>;
    readPresentedSession: <T>(actor: Actor, sessionId: string, render: (session: ProgressSession, presentation: ProgressPresentation, disclosure: {
        subject: boolean;
        versionSubject: boolean;
    }, measurePresentations: readonly ProgressMeasurePresentation[]) => Promise<T>) => Promise<T>;
    listSessions: (actor: Actor, subjectId: string, options?: Page) => Promise<{
        sessions: ProgressSession[];
        next: string | null;
    }>;
    listUnits: (actor: Actor, sessionId: string, options?: Page) => Promise<{
        units: import("./progress-model.ts").ProgressUnitRecord[];
        next: string | null;
    }>;
    listChanges: (actor: Actor, sessionId: string, options?: Page) => Promise<{
        changes: import("./progress-model.ts").ProgressChange[];
        next: string | null;
    }>;
};
export {};
