import type { Pool, PoolClient } from 'pg';
export type AccountAgentLink = {
    account: string;
    route: number;
    subject: string;
    agent_id: string;
    verified: boolean;
    receipt_id: string | null;
};
export declare class AccountAgentLabelEditError extends Error {
    readonly field = "labels";
    constructor();
}
export declare class AccountAgentWriteDeniedError extends Error {
    readonly subject: string;
    constructor(subject: string);
}
export declare class AccountAgentVerificationError extends Error {
    constructor(message?: string);
}
export declare class AccountAgentScopeGrowthError extends Error {
    readonly definitionsFile: string;
    constructor(definitionsFile: string);
}
type Queryable = Pick<PoolClient, 'query'>;
/** The stable graph identity for an account; its UUID route keeps it in the account partition. */
export declare function accountAgentId(account: string | {
    accountId: string;
}): string;
export declare function accountAgentsForSubjects(client: Pool | Queryable, subjects: readonly string[]): Promise<Map<string, AccountAgentLink>>;
export {};
