import type { Pool } from 'pg';
import { type KernelClock } from '../clock.ts';
import type { Access, Actor } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { type HostedReadingAddress, type HostedReadingListQuery, type HostedReadingListView, type HostedReadingClearInput, type HostedReadingPort, type HostedReadingSaveInput, type HostedReadingView } from './contract/hosted-reading.ts';
export { addressFromRow, hostedReadingPositionFromRow, parseHostedReadingPosition, validateHostedReadingClear, validateHostedReadingSave, type HostedReadingRow, } from './hosted-reading-validate.ts';
export type HostedReadingDependencies = {
    pool: Pool;
    tokens: KeyRing;
    access?: Access;
    clock?: KernelClock;
    content: HostedReadingPort;
};
export declare function createHostedReadingReads(dependencies: HostedReadingDependencies): {
    list(actor: Actor, query: HostedReadingListQuery, deadline: number, signal?: AbortSignal): Promise<HostedReadingListView>;
    get(actor: Actor, subjectId: string, deadline: number, signal?: AbortSignal): Promise<HostedReadingView>;
};
export declare function createHostedReadingCommands(dependencies: HostedReadingDependencies): {
    save(actor: Actor, input: HostedReadingSaveInput, requestKey: string, deadline: number): Promise<import("../command/command.ts").CommandOutcome<Readonly<{
        subjectId: string;
        revision: string;
        address: HostedReadingAddress;
    }>>>;
    clear(actor: Actor, input: HostedReadingClearInput, requestKey: string): Promise<import("../command/command.ts").CommandOutcome<Readonly<{
        subjectId: string;
        cleared: true;
    }>>>;
};
export declare function readHostedReadingExportPage(client: {
    query: Pool['query'];
}, route: number, accountId: string, afterId: string, limit: number): Promise<{
    key: string;
    subject_id: string;
    catalogue_id: string;
    publication_revision_id: string;
    occurrence_id: string;
    target_revision_id: string;
    target_sha256: string;
    document_block_id: string | null;
    document_offset: number | null;
    revision: string;
    changed_at: string | null;
}[]>;
