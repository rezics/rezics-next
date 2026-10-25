import type { Access, AccessContext, AccountActor } from '../request/access.ts';
import { type AuthoritativeTime } from '../command/command.ts';
import { type Account } from './account-data.ts';
import type { InitiatorRestoreInput, InitiatorRestorerConfig } from './durable-initiator.ts';
declare const durableIdentity: unique symbol;
export type DurableIdentity = {
    readonly [durableIdentity]: true;
};
type Facts = {
    scope: object;
    context: AccessContext;
    time: AuthoritativeTime;
    operation: InitiatorRestoreInput['operation'];
    action: string;
    resource: InitiatorRestoreInput['anchor']['resource'];
    actor: AccountActor;
    account: Account;
    deadline: number;
};
type Bridge = {
    scope: object;
    restore(proof: DurableIdentity, context: AccessContext, time: AuthoritativeTime): Promise<AccountActor>;
    discard(actor: AccountActor): void;
};
export declare function installDurableIdentityBridge(access: Access, bridge: Bridge): void;
/** Consumed once, only by the installed authenticator for this exact call. */
export declare function consumeDurableIdentity(proof: DurableIdentity, scope: object, context: AccessContext, time: AuthoritativeTime): Facts | undefined;
export declare function discardDurableIdentity(access: Access, actor: AccountActor): void;
/** The only mint path: actual owning-module read, exact native creation receipt,
 * Auth-owned current consent and independently anchored native account evidence.
 * The module reader's provenance obligations are exported in durable-initiator.
 */
export declare function restoreOperationIdentity(config: InitiatorRestorerConfig, input: InitiatorRestoreInput, time: AuthoritativeTime): Promise<AccountActor>;
export {};
