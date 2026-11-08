import type { Pool } from 'pg';
import { type CommandTransaction } from '../command/command.ts';
import { type Access, type AccessContext, type Actor, type Resource } from './check.ts';
/** Only kernel-authenticated actor objects belong in this context; request JSON
 * supplies the command input, never this context or an authorization decision.
 */
export type GrantCommandContext = AccessContext & {
    actor: Actor;
};
export declare function validResource(resource: Resource): boolean;
export declare function validActions(actions: readonly string[]): boolean;
/** Prepare separate anchors before resource checkout, then reuse the original
 * Access evaluator on the same SERIALIZABLE client on every command attempt.
 * Access enforces real evidence budgets at authorization; the command deadline
 * also bounds mutation completion. Authorization runs before receipt lookup at
 * the executor's trusted T, including on replay. A mutation may remove its own
 * grantor rights.
 */
export declare function grantCommand<T>(config: {
    pool: Pool;
    access: Access;
    clock?: (() => Date) | undefined;
}, context: GrantCommandContext, options: {
    resource: Resource;
    actions: readonly string[];
    consentedActions?: readonly string[];
    kind: string;
    key: string;
    input: unknown;
    denied: () => Error;
    /** A transfer's new direct holder must be a real active native account.
     * Checked on its source connection before target checkout, including replay. */
    recipientAccountId?: string;
    /** Exact Zone grant target and identity recipient, when the mutation writes grant rows. */
    zoneGrantTarget?: Readonly<{
        subjectAccountId?: string;
        addsGrant: boolean;
    }>;
}, mutate: (tx: CommandTransaction, transactionId: string) => Promise<T>): Promise<import("../command/command.ts").CommandOutcome<Awaited<T>>>;
