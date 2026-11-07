import type { Pool, PoolClient } from 'pg';
import type { FilterDocument } from '@rezics/filter';
import type { AuthoritativeTime } from '../../command/command.ts';
import { authoritativeTimeValue } from '../../command/command.ts';
import { currentCommandWorkAssociation } from '../../command/work-context.ts';
import { compileCurrentOwnerFilter } from '../../search/current-filter-plan.ts';
import type { CollectionRuleAuthorityCapability } from '../../library/contract/index.ts';
import type { Access, Actor } from '../../request/access.ts';
import { readAccountCommandState } from '../account-data.ts';
import { GrantDeniedError } from '../resource-access-errors.ts';
import { admitGroup } from '../gates/admission.ts';

/** Native Account authority and private owner-filter admission for Library rules. */
export function createNativeCollectionRuleAccountAuthority(): CollectionRuleAuthorityCapability {
  return {
    readAccount(client, route, accountId) {
      return readAccountCommandState(
        client as Pick<PoolClient, 'query'>,
        route,
        accountId,
        currentCommandWorkAssociation()?.access,
      );
    },
    async admitGroup(input) {
      const time = input.at as AuthoritativeTime;
      const work = currentCommandWorkAssociation()?.access;
      await admitGroup({
        pool: input.pool as Pool,
        access: () => input.access as Access,
        actor: input.actor as Actor,
        group: input.action === 'progress_session:read' ? 'reading_progress' : 'personal_library',
        clientAction: input.action,
        deadline: input.deadline,
        clock: () => new Date(authoritativeTimeValue(time)),
        ...(work ? { work } : {}),
        time,
      });
    },
    compileOwnerFilter(filter) {
      compileCurrentOwnerFilter(filter as FilterDocument);
    },
    denied() {
      return new GrantDeniedError();
    },
  };
}
