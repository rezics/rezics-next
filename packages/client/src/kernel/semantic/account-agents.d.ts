import type { Pool } from 'pg';
import type { AccountActor } from '../request/access.ts';
import { type Item } from './item.ts';
type Account = string | Pick<AccountActor, 'accountId'>;
type AgentKind = 'person' | 'organization' | 'software';
export declare class NoActiveDefinitionReleaseError extends Error {
    constructor();
}
/** Ensure one account graph agent at its deterministic account-partition id. */
export declare function ensureAccountAgent(pool: Pool, options: {
    account: Account;
    kind: AgentKind;
    name: string | null;
    language?: string;
}): Promise<{
    subject: Item;
    created: boolean;
}>;
/** Link a verified catalogue agent to the account's existing graph node. */
export declare function verifyAccountAgent(pool: Pool, options: {
    account: Account;
    catalogue: string;
    receipt: string;
}): Promise<{
    survivor: string;
    redirected: string;
    revision: number;
    subject: Item;
    component: {
        partition: number;
        epoch: number;
        position: bigint;
    };
}>;
/** Revoke a verified account-agent link and restore only the inbound links moved by that verification. */
export declare function unverifyAccountAgent(pool: Pool, options: {
    account: Account;
    receipt: string;
}): Promise<{
    survivor: string;
    redirected: string;
    revision: number;
    subject: Item;
    component: {
        partition: number;
        epoch: number;
        position: bigint;
    };
}>;
export {};
/** Read account agent ids in one SQL statement per requested account partition. */
