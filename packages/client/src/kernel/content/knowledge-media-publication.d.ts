import { type CommandTransaction } from '../command/command.ts';
import type { Actor } from '../request/access.ts';
/** Record exact public-selection retention within the owner's publication command.
 * This marker never grants a read, and a later document generation invalidates it.
 */
export declare function publishKnowledgeMedia(tx: CommandTransaction, input: Readonly<{
    documentId: string;
    revisionId: string;
    publicationId: string;
    author: Actor;
}>): Promise<void>;
