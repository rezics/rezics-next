import type { AccountActor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';

/** The account fields that decide live Collection authority; Access account rows satisfy this shape structurally. */
export type GrantedAccount = Readonly<{
  route: number;
  accountId: string;
  kind: string;
  state: string;
  fenced: boolean;
  minimumAuthnEpoch: bigint;
}>;

/** Live account authority for a private Collection. A token cached before suspension is not enough. */
export function grantCapable(account: GrantedAccount, viewer: AccountActor): boolean {
  const route = routeOf(viewer.accountId);
  return (
    route !== null &&
    account.route === route &&
    account.accountId === viewer.accountId &&
    account.kind === 'actor' &&
    account.state === 'active' &&
    account.fenced === false &&
    Number.isSafeInteger(viewer.authnEpoch) &&
    viewer.authnEpoch > 0 &&
    BigInt(viewer.authnEpoch) >= account.minimumAuthnEpoch &&
    viewer.scopes.includes('collection:read')
  );
}
