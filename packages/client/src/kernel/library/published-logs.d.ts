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
/** Public snapshot of one progress session. Later session edits do not change it. */
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
export type PublishedLogPageResult = {
    publishedLogs: PublishedLog[];
    next: string | null;
};
/**
 * Publish and retract one account's session snapshots. Reads are public, including for anonymous
 * viewers, and stay in the owner's partition. Nothing is written on the subject's partition.
 */
export declare function createPublishedLogCommands(config: Dependencies): {
    publishLog: (actor: Actor, input: {
        sessionId: string;
        note?: string | null;
    }, requestKey: string) => Promise<CommandOutcome<PublishedLog>>;
    retractLog: (actor: Actor, logId: string, requestKey: string) => Promise<CommandOutcome<PublishedLog>>;
    readPublishedLog: (_viewer: Actor, logId: string) => Promise<PublishedLog>;
    listPublishedLogs: (_viewer: Actor, page: Page) => Promise<PublishedLogPageResult>;
};
export {};
