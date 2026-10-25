import type { CommandTransaction } from '../command/command.ts';
import type { Resource } from '../request/access.ts';
export type RealmGroupGrant = {
    resource: Resource;
    principal: {
        kind: 'realm';
        id: string;
    };
    role: 'owner' | 'member';
    resourceRole: string;
};
/** Writes one identity `resource_role_grant` from the command's T for a Realm owner or member group.
 * A current member holds `resourceRole` through that row; a former member stops when the membership proof ends.
 */
export declare function grantGroupRole(tx: CommandTransaction, input: RealmGroupGrant): Promise<void>;
