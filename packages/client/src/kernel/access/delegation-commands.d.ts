export { readAssignment, type AssignmentEvidence } from './delegation-read.ts';
import type { Pool } from 'pg';
import type { Access } from '../request/access.ts';
import { type GrantCommandContext } from './grant-command.ts';
export declare class DelegationDeniedError extends Error {
    constructor();
}
export type AssignmentInput = {
    principalId: string;
    assignedActorId: string;
    requestId: string;
    valid: string;
    key: string;
};
export type AssignmentRevokeInput = Pick<AssignmentInput, 'principalId' | 'requestId' | 'key'>;
/** The principal is the authenticated actor and the account anchor. The body
 * cannot supply a creator; immutable request identity survives revocation.
 */
export declare function createDelegationCommands(config: {
    pool: Pool;
    access: Access;
    action: string;
}): {
    create: (context: GrantCommandContext, input: AssignmentInput) => Promise<import("../command/command.ts").CommandOutcome<{
        requestedBy: string;
    }>>;
    revoke: (context: GrantCommandContext, input: AssignmentRevokeInput) => Promise<import("../command/command.ts").CommandOutcome<{
        requestedBy: string;
    }>>;
};
