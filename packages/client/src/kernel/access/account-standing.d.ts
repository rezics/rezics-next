import type { Access, AccessContext, Resource, ResourcePage } from '../request/access.ts';
export type AccountStandingInput = Readonly<{
    accountId: string;
    action: string;
    target: Resource | ResourcePage;
    context: AccessContext;
}>;
export type AccountStandingDecisions = Readonly<Record<string, boolean>>;
type Check = (input: AccountStandingInput) => Promise<AccountStandingDecisions>;
/** Internal factory registration; callers cannot install evidence on an adapter. */
export declare function installAccountStandingCheck(access: Access, check: Check): void;
/** Current durable account permission. No bearer, client, scopes, delegation or caller time is accepted. */
export declare function accountStandingCheck(access: Access, input: AccountStandingInput): Promise<AccountStandingDecisions>;
export {};
