import { type CommandTransaction } from '../command/command.ts';
import type { Resource } from '../request/access.ts';
/** Called INSIDE the owning module's new-resource transaction, after its unique
 * resource INSERT. The parentCreationAuthorization capability fixes the creator,
 * exact child resource, partition and shared attempt T. This writes role IDs,
 * without opening a connection or command. The native grant trigger captures the
 * initial holder. Finalization requires each declared entry to complete successfully.
 * Empty trusted templates (reports/communal subjects) intentionally grant none.
 */
export declare function initializeResourceGrants(tx: CommandTransaction, input: {
    resource: Resource;
    type: string;
    creator: string;
}): Promise<void>;
