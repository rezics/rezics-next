import { installRatingVoteSemantic } from './rating-votes.ts';
import { createInitiatorRestorer } from '../access/durable-initiator.ts';
import { erasureWorkModule } from '../access/erasure.ts';
import { sharedHistoryWorkModule } from '../history/application/index.ts';
import { createAccountsWorkModule } from '../access/membership-work.ts';
import { readMembershipWorkConfig } from '../access/membership-work-config.ts';
import { readMembershipInitiator } from '../community/membership.ts';
import {
  createCommunityDeclaration,
  systemCommunityAmbient,
  type CommunityAmbient,
  type CommunityDeclaration,
} from '../community/declaration.ts';
import { contentDeclaration, type ContentWorkAmbient } from '../content/register.ts';
import type { WorkModule } from '../work/registry.ts';
import { commerceWorkModule } from '../commerce/work-module.ts';
import { libraryWorkModule } from '../library/work-module.ts';
import { createSemanticWorkModule, type SemanticDomainComposer } from '../semantic/work-module.ts';
import { createSearchWorkModule } from '../search/work.ts';
import { ratingNativeWorkModule } from '../rating/module.ts';
import { workflowRetentionWorkModule } from '../work/retention.ts';
import { importsWorkModule } from '../imports/erasure.ts';
import { composeContentApplication } from './content.ts';
import { installIdentityRatingRepairProducer } from './identity-rating-repair.ts';

/** Accounts registration installs the Realm adapter before any Realm workflow runs.
 * Its Access is the production composition, so a step authorizes only the initiator
 * that the restorer returns for its committed operation. The Realm membership reader
 * comes from the Community declaration, so it shares that declaration's deadline clock.
 */
function accountsWorkModule(community: CommunityDeclaration): WorkModule {
  return {
    name: 'accounts',
    async register(context) {
      const config = readMembershipWorkConfig(context.env);
      const { access, readConsent } = context.getAuthorization();
      const membership = community.createMembership({
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
}

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

/** Callable default-worker composition. `startWorker` invokes this with Content ambient; Library
 * and Search outcome children decorate that live list. Add each module's registration here, in
 * dependency order, once. Content's worker is the declared factory over explicit network, clock
 * and identity operands supplied by this composition root. Community's worker is the declared factory
 * over the request-deadline operand. */
export function createKernelWorkModules(
  composeDiscovery: Parameters<typeof createSearchWorkModule>[0],
  composeRuntimeDefaults: Parameters<typeof createSearchWorkModule>[1],
  composeSemantic: SemanticDomainComposer,
  ambient?: ContentWorkAmbient,
  composeCreditSearch?: Parameters<typeof createSearchWorkModule>[2],
  communityAmbient: CommunityAmbient = systemCommunityAmbient,
): readonly WorkModule[] {
  installIdentityRatingRepairProducer();
  installRatingVoteSemantic();
  const searchWorkModule = createSearchWorkModule(composeDiscovery, composeRuntimeDefaults, composeCreditSearch);
  const semanticWorkModule = createSemanticWorkModule(composeSemantic);
  const contentWorkModule = contentDeclaration().work(contentWorkAmbient(ambient));
  const community = createCommunityDeclaration(communityAmbient);
  return [
    accountsWorkModule(community),
    erasureWorkModule,
    sharedHistoryWorkModule,
    ratingNativeWorkModule,
    commerceWorkModule,
    libraryWorkModule,
    community.work,
    semanticWorkModule,
    searchWorkModule,
    importsWorkModule,
    contentWorkModule,
    workflowRetentionWorkModule,
  ];
}
