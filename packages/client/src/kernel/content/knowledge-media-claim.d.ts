import { type CommandTransaction } from '../command/command.ts';
import type { Actor } from '../request/access.ts';
/** Claim the exact stored revision after its document head and placement exist.
 * The document container fixes ownership; subsequent own revisions can retain the
 * same image without replacing its first claim or using a Post identity.
 */
export declare function claimKnowledgeMedia(tx: CommandTransaction, input: Readonly<{
    mediaIds: readonly string[];
    documentId: string;
    revisionId: string;
    author: Actor;
}>): Promise<void>;
