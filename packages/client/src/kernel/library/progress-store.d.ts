import type { PoolClient } from 'pg';
import type { ProgressMode, ProgressState } from './progress.ts';
import type { LibraryProgressUnitDescriptor, LibraryProfilePin } from './profile.ts';
import { type ProgressChange, type ProgressChangePage, type ProgressSession, type ProgressSessionJournal, type ProgressSessionDraft, type ProgressSessionPage, type ProgressSessionUpdate, type ProgressUnitRecord, type ProgressUnitPage } from './progress-model.ts';
type Client = Pick<PoolClient, 'query'>;
type WriteContext = {
    transactionId: string;
    time: string;
};
export type ProgressDiscoveryFact = {
    session: ProgressSession;
    profilePin: LibraryProfilePin | null;
};
export type ProgressDiscoveryFilter = {
    subjectId?: string;
    state?: Exclude<ProgressState, 'retired'>;
    mode?: ProgressMode;
    profileId?: string;
};
export type ProgressDiscoveryAfter = {
    startedAt: string;
    sessionId: string;
};
export declare function insertSession(client: Client, route: number, session: ProgressSessionDraft, context: WriteContext, pin?: LibraryProfilePin, meaningDescriptors?: readonly Readonly<{
    mode: ProgressMode;
    descriptor: LibraryProgressUnitDescriptor;
}>[]): Promise<ProgressSession>;
export declare function readSession(client: Client, route: number, sessionId: string): Promise<ProgressSession | null>;
export declare function readSessionFact(client: Client, route: number, sessionId: string): Promise<{
    session: ProgressSession;
    pin: LibraryProfilePin | null;
} | null>;
export declare function readSessionJournal(client: Client, route: number, accountId: string, sessionId: string): Promise<ProgressSessionJournal | null>;
export declare function lockSessionJournal(client: Client, route: number, accountId: string, sessionId: string): Promise<(ProgressSessionJournal & {
    assessmentPresence: string | null;
}) | null>;
export declare function updateSessionJournal(client: Client, route: number, accountId: string, sessionId: string, expectedRevision: number, journal: ProgressSessionJournal, assessmentPresence?: 'explicit_null' | 'value'): Promise<ProgressSessionJournal | null>;
export declare function updateSession(client: Client, route: number, sessionId: string, revision: number, changes: ProgressSessionUpdate, context: WriteContext): Promise<ProgressSession>;
export declare function addUnits(client: Client, route: number, sessionId: string, unitIds: readonly string[], context: WriteContext): Promise<number>;
export declare function removeUnits(client: Client, route: number, sessionId: string, unitIds: readonly string[]): Promise<number>;
export declare function appendChange(client: Client, route: number, sessionId: string, changeNo: number, intent: unknown, context: WriteContext): Promise<ProgressChange>;
export declare function pageSessions(client: Client, route: number, accountId: string, subjectId: string, page: ProgressSessionPage): Promise<ProgressSession[]>;
export declare function progressDiscoveryGeneration(client: Client, route: number, accountId: string): Promise<string>;
export declare function pageProgressDiscovery(client: Client, route: number, accountId: string, filter: ProgressDiscoveryFilter, after: ProgressDiscoveryAfter | null, limit: number): Promise<ProgressDiscoveryFact[]>;
export declare function pageUnits(client: Client, route: number, sessionId: string, page: ProgressUnitPage): Promise<ProgressUnitRecord[]>;
export declare function pageChanges(client: Client, route: number, sessionId: string, page: ProgressChangePage): Promise<ProgressChange[]>;
export {};
