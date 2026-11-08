import { composeRatingDependencies } from './rating.ts';
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
import { readRealmSubjectIdentityMappings } from '../content/adapters/index.ts';
import { installIdentityRatingRepairProducer } from './identity-rating-repair.ts';
import type { SearchNativePorts } from '../search/composition.ts';

type SearchNativePortsComposer = () => SearchNativePorts | Promise<SearchNativePorts>;

/** Load SQL-backed producers only when registration has the prepared worker pool. */
function createSearchNativePortsComposer(): SearchNativePortsComposer {
  let ports: Promise<SearchNativePorts> | undefined;
  return () =>
    (ports ??= import('./search-native.ts').then(({ composeSearchNativePorts }) => composeSearchNativePorts()));
}

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

function contentWorkAmbient(supplied?: Partial<ContentWorkAmbient>): ContentWorkAmbient {
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
    readIdentityMappings: supplied?.readIdentityMappings ?? readRealmSubjectIdentityMappings,
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
  ambient?: Partial<ContentWorkAmbient>,
  composeCreditSearch?: Parameters<typeof createSearchWorkModule>[2],
  communityAmbient: CommunityAmbient = systemCommunityAmbient,
  suppliedSearchNativePorts?: SearchNativePortsComposer,
): readonly WorkModule[] {
  composeRatingDependencies();
  installIdentityRatingRepairProducer();
  installRatingVoteSemantic();
  const composeNativePorts = suppliedSearchNativePorts ?? createSearchNativePortsComposer();
  const composeNativeAccess: Parameters<typeof createSearchWorkModule>[4] = async (input) => {
    const { composeSearchNativeAccess } = await import('./search-native.ts');
    return composeSearchNativeAccess(input);
  };
  const searchWorkModule = createSearchWorkModule(
    composeDiscovery,
    composeRuntimeDefaults,
    composeCreditSearch,
    composeNativePorts,
    composeNativeAccess,
  );
  const semanticWorkModule = createSemanticWorkModule(composeSemantic, composeNativePorts);
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
