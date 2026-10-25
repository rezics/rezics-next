import type { Pool } from 'pg';
import { type CommandAuthorization, type CommandTransaction, type CommandOutcome } from '../command/command.ts';
import type { AccountActor } from '../request/access.ts';
export declare class LifecycleDeniedError extends Error {
    constructor();
}
type Mutation = {
    route: number;
    id: string;
    kind: string;
    key: string;
    input: unknown;
    actor?: AccountActor;
    deadline?: number;
    authorization?: CommandAuthorization;
};
/** All idempotency digests include the anchor, actual kernel actor/client and
 * requested_by. Core's partition receipt key is explicitly prefixed by route.
 * Responses/events contain identity and coordination facts, never patch bodies.
 */
export declare function lifecycleExecutor(pool: Pool, clock?: () => Date): <T>(options: Mutation, body: (tx: CommandTransaction, transactionId: string) => Promise<T>) => Promise<CommandOutcome<T>>;
export {};
