import { createAccountsWorkModule } from '../access/membership-work.ts';
import { readMembershipWorkConfig } from '../access/membership-work-config.ts';
import { createAccess } from '../access/permission.ts';
import roles from '../access/resource-roles.json';
import { createRealmMembership } from '../community/membership.ts';
import { communityWorkModule } from '../community/work.ts';
import { registerContent } from '../content/register.ts';
import type { WorkModule } from './registry.ts';
import { commerceWorkModule } from '../commerce/work-module.ts';
import { libraryWorkModule } from '../library/work-module.ts';
import { searchWorkModule } from '../search/work.ts';

/** Every action named by a resource role. A missing action drops the whole role. */
function realmActionCatalogue() {
  const names = new Set<string>();
  for (const actions of Object.values(roles.roles)) for (const action of actions) names.add(action);
  return new Map([...names].map((action) => [action, { anonymous: false }]));
}

/** Accounts registration installs the Realm adapter before any Realm workflow runs. */
const accountsWorkModule: WorkModule = {
  name: 'accounts',
  async register(context) {
    const config = readMembershipWorkConfig(context.env);
    let membership: ReturnType<typeof createRealmMembership> | undefined;
    const access = createAccess({
      actions: realmActionCatalogue(),
      accountEvidence: (_actor, request) => request.account ?? null,
      realmRoleReader: (client, input) => {
        if (!membership) throw new Error('Realm membership role reader is not installed');
        return membership.roleReader(client, input);
      },
      clock: context.clock,
    });
    membership = createRealmMembership({
      pool: context.pool,
      access,
      referenceKeys: config.referenceKeys,
      clock: context.clock,
    });
    await createAccountsWorkModule({ realm: membership }).register(context);
  },
};

/** Add each module's registration here, in dependency order, once. */
export const KERNEL_WORK_MODULES: readonly WorkModule[] = [
  accountsWorkModule,
  commerceWorkModule,
  libraryWorkModule,
  communityWorkModule,
  searchWorkModule,
  registerContent,
];
