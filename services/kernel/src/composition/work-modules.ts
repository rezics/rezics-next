import { createInitiatorRestorer } from '../access/durable-initiator.ts';
import { erasureWorkModule } from '../access/erasure.ts';
import { sharedHistoryWorkModule } from '../history/work.ts';
import { createAccountsWorkModule } from '../access/membership-work.ts';
import { readMembershipWorkConfig } from '../access/membership-work-config.ts';
import { createRealmMembership, readMembershipInitiator } from '../community/membership.ts';
import { communityWorkModule } from '../community/work.ts';
import { contentDeclaration, type ContentWorkAmbient } from '../content/register.ts';
import type { WorkModule } from '../work/registry.ts';
import { commerceWorkModule } from '../commerce/work-module.ts';
import { libraryWorkModule } from '../library/work-module.ts';
import { createSemanticWorkModule, type SemanticIdentityParticipantComposer } from '../semantic/work-module.ts';
import { createSearchWorkModule } from '../search/work.ts';
import { ratingNativeWorkModule } from '../rating/module.ts';
import { workflowRetentionWorkModule } from '../work/retention.ts';
import { importsWorkModule } from '../imports/erasure.ts';
import { composeContentApplication } from './content.ts';

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

function contentWorkAmbient(supplied?: ContentWorkAmbient): ContentWorkAmbient {
  return {
    fetch: (request) => {
      const fetch = supplied?.fetch ?? composeContentApplication().ambient.fetch;
      return fetch(request);
    },
    now: () => {
      const now = supplied?.now ?? composeContentApplication().ambient.now;
      return now();
    },
    id: () => {
      const id = supplied?.id ?? composeContentApplication().ambient.id;
      return id();
    },
  };
}

/** Callable default-worker composition. `startWorker` invokes this with Content ambient; Search
 * outcome children decorate that live list. Add each module's registration here, in dependency
 * order, once. Content's worker is the declared factory over explicit network, clock and identity
 * operands supplied by this composition root. */
export function createKernelWorkModules(
  composeDiscovery: Parameters<typeof createSearchWorkModule>[0],
  composeRuntimeDefaults: Parameters<typeof createSearchWorkModule>[1],
  composeSemantic: SemanticIdentityParticipantComposer,
  ambient?: ContentWorkAmbient,
): readonly WorkModule[] {
  const searchWorkModule = createSearchWorkModule(composeDiscovery, composeRuntimeDefaults);
  const semanticWorkModule = createSemanticWorkModule(composeSemantic);
  const contentWorkModule = contentDeclaration().work(contentWorkAmbient(ambient));
  return [
    accountsWorkModule,
    erasureWorkModule,
    sharedHistoryWorkModule,
    ratingNativeWorkModule,
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
