import type { Access, AccessContext, Resource, ResourcePage } from '../request/access.ts';
import { accessRoot } from './derived-access.ts';

/** An account's own principal, without any session or delegation authority. */
export type StandingPrincipal = Readonly<{
  kind: 'account';
  accountId: string;
  clientId?: never;
  scopes?: never;
  requestedBy?: never;
  authnEpoch?: never;
}>;
export type AccountStandingInput = Readonly<{
  accountId: string;
  action: string;
  target: Resource | ResourcePage;
  context: AccessContext;
}>;
export type AccountStandingDecisions = Readonly<Record<string, boolean>>;
type Check = (input: AccountStandingInput) => Promise<AccountStandingDecisions>;
const checks = new WeakMap<Access, Check>();

/** Internal factory registration; callers cannot install evidence on an adapter. */
export function installAccountStandingCheck(access: Access, check: Check): void {
  if (accessRoot(access) !== access || checks.has(access)) throw new Error('Account standing port already installed');
  checks.set(access, check);
}

/** Current durable account permission. No bearer, client, scopes, delegation or caller time is accepted. */
export async function accountStandingCheck(
  access: Access,
  input: AccountStandingInput,
): Promise<AccountStandingDecisions> {
  const check = checks.get(accessRoot(access));
  if (!check) throw new Error('Account standing port is not installed');
  return check(input);
}
