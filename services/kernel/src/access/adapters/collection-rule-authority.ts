/** Access owns current Account command state; Library owns the authority decision. */
import type { PoolClient } from 'pg';
import { currentCommandWorkAssociation } from '../../command/work-context.ts';
import type { CollectionRuleAuthorityCapability } from '../../library/contract/index.ts';
import { readAccountCommandState } from '../account-data.ts';

/** Preserve the original transaction and charge the caller's existing Access ledger. */
export function createNativeCollectionRuleAccountAuthority(): Pick<CollectionRuleAuthorityCapability, 'readAccount'> {
  return {
    readAccount(client, route, accountId) {
      return readAccountCommandState(
        client as Pick<PoolClient, 'query'>,
        route,
        accountId,
        currentCommandWorkAssociation()?.access,
      );
    },
  };
}
