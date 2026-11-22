import type { AccessClient } from '../../request/access.ts';
/** Lock owner facts on the Economy checkout before a private read, replay or posting.
 * The configured node is the owner of this pool; this port admits only collocated homes.
 */
export declare function lockNativeEconomyAdmission(client: AccessClient, input: {
    node: string;
    accountId: string;
    recipientId?: string;
}): Promise<'allowed' | 'source_denied' | 'recipient_denied' | 'unavailable'>;
