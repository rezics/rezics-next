import { type CommandTransaction } from '../command/command.ts';
import type { Resource } from '../request/access.ts';
/** Called INSIDE the owning module's new-resource transaction, after its unique
 * resource INSERT. The parentCreationAuthorization capability fixes the creator,
 * exact child resource, partition and shared attempt T. This writes role IDs,
 * never action copies, and never opens a connection/command. Completion follows
 * successful native writes; finalization rejects missing or failed entries even
 * when the body catches errors.
 * Empty trusted templates (reports/communal subjects) intentionally grant none.
 */
export declare function initializeResourceGrants(tx: CommandTransaction, input: {
    resource: Resource;
    type: string;
    creator: string;
}): Promise<void>;
