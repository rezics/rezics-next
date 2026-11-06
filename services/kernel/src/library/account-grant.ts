import type { AccountActor } from '../request/access.ts';
import type { GrantedAccount as ContractGrantedAccount } from './contract/index.ts';
import { grantCapable as grantCapableCore } from './core/index.ts';

/** The account fields that decide live Collection authority; Access account rows satisfy this shape structurally. */
export type GrantedAccount = ContractGrantedAccount;

/** Live account authority for a private Collection. A token cached before suspension is not enough. */
export function grantCapable(account: GrantedAccount, viewer: AccountActor): boolean {
  return grantCapableCore(account, viewer);
}
