import { type AuthoritativeTime } from '../command/command.ts';
import type { AccessClient, Resource } from '../request/access.ts';
/** Reports only a direct identity role grant at T, using the caller's transaction snapshot.
 * The caller must already have authorized this read and must not disclose the answer to anyone else.
 * This is data, not a permission check: group grants, active_accounts and account state are ignored.
 */
export declare function resourceRoleHeld(client: AccessClient, input: {
    resource: Resource;
    role: string;
    accountId: string;
    at: AuthoritativeTime;
}): Promise<boolean>;
