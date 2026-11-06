/** Live account authority for a private Collection. A token cached before suspension is not enough. */

import type { GrantedAccount, LibraryAccountActor } from '../contract/index.ts';
import { routeOf } from './route.ts';

export function grantCapable(account: GrantedAccount, viewer: LibraryAccountActor): boolean {
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
