import type { BuiltinOwnerAdmission, CurrentAccountEligibilityCapability } from '../contract/index.ts';
import { currentLibraryAccount } from '../core/index.ts';

export function createBuiltinOwnerAdmission<Client>(
  capability: CurrentAccountEligibilityCapability<Client>,
): BuiltinOwnerAdmission<Client> {
  return async (client, actor, scope = 'collection:read') => {
    if (actor.kind !== 'account' || !actor.scopes.includes(scope)) return null;
    const route = capability.routeOf(actor.accountId);
    if (route === null) return null;
    return currentLibraryAccount(actor, await capability.readAccount(client, route, actor.accountId)) ? actor : null;
  };
}
