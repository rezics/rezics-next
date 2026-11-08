import type { Pool, PoolClient } from 'pg';
import type { Release } from '@rezics/definitions';
import { type CommandAuthorization, type CommandTransaction } from '../command/command.ts';
import { type Access, type Actor, type AccountActor } from '../request/access.ts';
export type StatementReader = {
    account: string;
    moderator: (client: CommandTransaction) => Promise<boolean>;
};
/** Prepare audience evidence outside the source checkout after every freshness wait. */
export declare function refreshStatementReaderAuthorization(): Promise<void>;
/** Restrict disclosure throughout nested hydration without changing caller authority. */
export declare function withPublicStatementReader<T>(fn: () => T): T;
/** Request-scoped audience; relays, exports and background work always use the public view. */
export declare function withStatementReader<T>(reader: StatementReader, read: () => T): T;
export declare function readStatementAs<T>(pool: Pool, access: Access, actor: Actor, deadline: number, read: (refreshAuthorization: () => Promise<void>) => Promise<T>): Promise<T>;
export declare function statementAudience(client: CommandTransaction): Promise<{
    viewer_account: string;
    viewer_moderator: boolean;
}>;
/** Validate consent at the same transaction snapshot as the proposal, including bulk writes. */
export declare function disclosureAccount(tx: CommandTransaction, release: Release, property: string, body: unknown): Promise<string | null>;
export declare function keepStatementPrivate(tx: CommandTransaction, input: {
    subject: string;
    candidate: string;
    slot: string;
    property: string;
    body: unknown;
    account: string;
    revision: number;
    release: Release;
}): Promise<void>;
export type PrivateLink = {
    route: number;
    subject_id: string;
    candidate_id: string;
    target_id: string;
    property: string;
    slot_id: string;
    statement: unknown;
    release: string;
    revision: number;
    rank: 'normal' | 'preferred';
    source_type: string;
    target_type: string;
    order_key: string;
};
export declare function privateLinks(client: PoolClient, input: {
    subject: string;
    inbound?: boolean;
    property?: string | null;
    crossProperty?: boolean;
    after?: readonly unknown[] | undefined;
    limit: number;
}): Promise<{
    entries: PrivateLink[];
}>;
export declare class StatementDisclosureDeniedError extends Error {
}
export declare class StatementDisclosureNotFoundError extends Error {
}
export declare class StatementDisclosureConflictError extends Error {
}
/** Target-account consent and its terminal retraction share receipt and ownership checks. */
export declare function changeStatementDisclosure(pool: Pool, options: {
    candidate: string;
    retract?: boolean;
    actor: AccountActor;
    idempotencyKey: string;
    digest: Uint8Array;
    authorization: CommandAuthorization;
    deadline: number;
    clock?: () => Date;
    routeKey?: Uint8Array;
}): Promise<{
    candidate: string;
    disclosed: boolean;
    component: {
        partition: number;
        epoch: number;
        position: bigint;
    };
}>;
