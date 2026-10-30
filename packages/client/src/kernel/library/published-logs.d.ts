import type { Pool } from 'pg';
import { type CommandOutcome } from '../command/command.ts';
import type { KernelClock } from '../clock.ts';
import type { Access, Actor } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { ProgressState } from './progress.ts';
type Dependencies = {
    pool: Pool;
    access: Access;
    tokens: KeyRing;
    clock?: KernelClock;
};
type Page = {
    accountId: string;
    cursor?: string | undefined;
    limit?: number | undefined;
};
/** Explicit public snapshot. No private session values are read by Undo. */
export type PublishedLog = {
    id: string;
    accountId: string;
    subjectId: string;
    sessionState: ProgressState;
    startedAt: string;
    completedAt: string | null;
    note: string | null;
    publishedAt: string;
};
export type PublishedLogTombstone = {
    id: string;
    deleted: true;
};
export type PublishedLogPageResult = {
    publishedLogs: PublishedLog[];
    next: string | null;
};
export type PublishedLogOutcome = CommandOutcome<PublishedLog> & {
    revision?: number;
    deletionId?: string;
};
export declare function createPublishedLogCommands(config: Dependencies): {
    publishLog: (actor: Actor, input: {
        sessionId: string;
        note?: string | null;
    }, requestKey: string) => Promise<PublishedLogOutcome>;
    retractLog: (actor: Actor, logId: string, requestKey: string, revision?: number) => Promise<PublishedLogOutcome>;
    restoreLog: (actor: Actor, logId: string, input: unknown, requestKey: string) => Promise<PublishedLogOutcome>;
    readWithRevision: (viewer: Actor, logId: string) => Promise<{
        publishedLog: PublishedLog | PublishedLogTombstone;
        revision?: number;
    }>;
    readPublishedLog: (viewer: Actor, logId: string) => Promise<PublishedLog | PublishedLogTombstone>;
    listPublishedLogs: (viewer: Actor, page: Page) => Promise<PublishedLogPageResult>;
};
export {};
