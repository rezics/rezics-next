import type { Pool } from 'pg';
import type { KernelClock } from '../../clock.ts';
import { type CommandAttempt } from '../../command/command.ts';
import type { Access, AccessContext, AccessClient } from '../../request/access.ts';
import { type CollectionPublicationEpisodes } from '../collection-publication-episodes.ts';
export interface NativeCollectionPublicationCommandPorts {
    commandAccessContext(context: AccessContext, attempt: CommandAttempt): AccessContext;
    deadlineClient(client: AccessClient, deadline: number): AccessClient;
    denied(): Error;
}
/** Ordinary authenticated collection:update, including fresh admission BEFORE receipt lookup on every replay. */
export declare function createNativeCollectionPublicationEpisodes(config: {
    pool: Pool;
    access: Access;
    clock?: KernelClock;
}, ports: NativeCollectionPublicationCommandPorts): CollectionPublicationEpisodes;
