import { createInitiatorRestorer } from '../access/durable-initiator.ts';
import { erasureWorkModule } from '../access/erasure.ts';
import { sharedHistoryWorkModule } from '../history/work.ts';
import { createAccountsWorkModule } from '../access/membership-work.ts';
import { readMembershipWorkConfig } from '../access/membership-work-config.ts';
import { createRealmMembership, readMembershipInitiator } from '../community/membership.ts';
import { communityWorkModule } from '../community/work.ts';
import { contentDeclaration, type ContentWorkAmbient } from '../content/register.ts';
import type { WorkModule } from './registry.ts';
import { commerceWorkModule } from '../commerce/work-module.ts';
import { libraryWorkModule } from '../library/work-module.ts';
import { semanticWorkModule } from '../semantic/work-module.ts';
import { createSearchWorkModule } from '../search/work.ts';
import { ratingWorkModule } from '../rating/work-module.ts';
import { workflowRetentionWorkModule } from './retention.ts';
import { importsWorkModule } from '../imports/erasure.ts';

/** Accounts registration installs the Realm adapter before any Realm workflow runs.
 * Its Access is the production composition, so a step authorizes only the initiator
 * that the restorer returns for its committed operation.
 */
const accountsWorkModule: WorkModule = {
  name: 'accounts',
  async register(context) {
    const config = readMembershipWorkConfig(context.env);
    const { access, readConsent } = context.getAuthorization();
    const membership = createRealmMembership({
      pool: context.pool,
      access,
      referenceKeys: config.referenceKeys,
      clock: context.clock,
      restorer: createInitiatorRestorer({
        pool: context.pool,
        access,
        readOperation: readMembershipInitiator,
        readConsent,
      }),
    });
    await createAccountsWorkModule({ realm: membership }).register(context);
  },
};

/** Add each module's registration here, in dependency order, once. The process network capability is supplied
 * by trusted composition; the default is the platform fetch. */
export function createKernelWorkModules(
  composeDiscovery: Parameters<typeof createSearchWorkModule>[0],
  composeRuntimeDefaults: Parameters<typeof createSearchWorkModule>[1],
  ambient: ContentWorkAmbient = { fetch: (request) => globalThis.fetch(request) },
): readonly WorkModule[] {
  const searchWorkModule = createSearchWorkModule(composeDiscovery, composeRuntimeDefaults);
  const contentWorkModule = contentDeclaration().work(ambient);
  return [
    accountsWorkModule,
    erasureWorkModule,
    sharedHistoryWorkModule,
    ratingWorkModule,
    commerceWorkModule,
    libraryWorkModule,
    communityWorkModule,
    semanticWorkModule,
    searchWorkModule,
    importsWorkModule,
    contentWorkModule,
    workflowRetentionWorkModule,
  ];
}
