import { createAuthConsentReader, readAuthConsentConfig, type CurrentConsentReader } from '../access/auth-consent.ts';
import { createInitiatorRestorer } from '../access/durable-initiator.ts';
import { erasureWorkModule } from '../access/erasure.ts';
import { createAccess } from '../access/index.ts';
import { createAccountsWorkModule } from '../access/membership-work.ts';
import { readMembershipWorkConfig } from '../access/membership-work-config.ts';
import roles from '../access/resource-roles.json';
import { createRealmMembership, readMembershipInitiator } from '../community/membership.ts';
import { communityWorkModule } from '../community/work.ts';
import { registerContent } from '../content/register.ts';
import type { WorkModule } from './registry.ts';
import { commerceWorkModule } from '../commerce/work-module.ts';
import { libraryWorkModule } from '../library/work-module.ts';
import { semanticWorkModule } from '../semantic/work-module.ts';
import { searchWorkModule } from '../search/work.ts';
import { ratingWorkModule } from '../rating/work-module.ts';
import { workflowRetentionWorkModule } from './retention.ts';
import { importsWorkModule } from '../imports/erasure.ts';

/** Every action named by a resource role. A missing action drops the whole role. */
function realmActionCatalogue() {
  const names = new Set<string>();
  for (const actions of Object.values(roles.roles)) for (const action of actions) names.add(action);
  return new Map([...names].map((action) => [action, { anonymous: false }]));
}

/** The kernel's one Auth consent configuration. Absent, restoration is unavailable and its steps fail. */
function consentReader(env: Readonly<Record<string, string | undefined>>): CurrentConsentReader {
  const consent = readAuthConsentConfig(env);
  return consent === null
    ? async () => {
        throw new Error('Auth consent is not configured');
      }
    : createAuthConsentReader(consent);
}

/** Accounts registration installs the Realm adapter before any Realm workflow runs.
 * Its Access is the production composition, so a step authorizes only the initiator
 * that the restorer returns for its committed operation.
 */
const accountsWorkModule: WorkModule = {
  name: 'accounts',
  async register(context) {
    const config = readMembershipWorkConfig(context.env);
    let membership: ReturnType<typeof createRealmMembership> | undefined;
    const access = createAccess({
      actions: realmActionCatalogue(),
      auth: config.auth,
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
      restorer: createInitiatorRestorer({
        pool: context.pool,
        access,
        readOperation: readMembershipInitiator,
        readConsent: consentReader(context.env),
      }),
    });
    await createAccountsWorkModule({ realm: membership }).register(context);
  },
};

/** Add each module's registration here, in dependency order, once. */
export const KERNEL_WORK_MODULES: readonly WorkModule[] = [
  accountsWorkModule,
  erasureWorkModule,
  ratingWorkModule,
  commerceWorkModule,
  libraryWorkModule,
  communityWorkModule,
  semanticWorkModule,
  searchWorkModule,
  importsWorkModule,
  registerContent,
  workflowRetentionWorkModule,
];
