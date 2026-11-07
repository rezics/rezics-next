/** Native Access implementation of the Library-owned behaviour port. */
import type { LibraryAccessPorts } from '../../library/access-port.ts';
import { deadlineClient, within } from '../authenticate.ts';
import { readAccount, readAccountCommandState } from '../account-data.ts';
import { actingCommandAccount, commandAccessContext, requireCommandAdmission } from '../command-admission.ts';
import { admitGroup } from '../gates/admission.ts';
import { captureDurableInitiator, durableInitiatorCommitment } from '../durable-initiator-capture.ts';
import { resourceAuthorization, resourceAuthorizationPage } from '../resource-authorization.ts';
import { createResourcePublicEligibility } from '../public-eligibility.ts';
import { creationDeclares, parentCreationAuthorization } from '../parent-creation.ts';
import { initializeResourceGrants } from '../resource-initialization.ts';
import { readViewerActions } from '../viewer-actions.ts';
import { createNativeCopyAccountAdmission, nativeCopyAccountWork } from './copy-account.ts';
import { fenceOperationalAccount, shareAccount } from '../account-share.ts';
import { createInitiatorRestorer } from '../durable-initiator.ts';
import { accessRoot, deriveAccess } from '../derived-access.ts';
import { installResourceRoleCatalogue, resourceRoleCatalogue } from '../resource-roles.ts';
import { readPublicViews } from '../public-views.ts';
import { readMembershipRouteKey, readMembershipWorkConfig } from '../membership-work-config.ts';
import { isAccessWorkDispatch } from '../work.ts';
import { agentContributionAttribution, contributionDeleted, readContributionAttributions } from '../public-identity.ts';
import { collectionAuthorizationPreparationWork, specializeCollectionList } from './collection-policy.ts';
import { readAccountDiscoverySummaries } from '../account-discovery-source.ts';
import { ACCESS_EVENTS } from '../events.ts';
import {
  admitLiveCopyRoles,
  cancelLiveCopy,
  consumeLiveCopy,
  finishLiveCopyGate,
  liveCopyLocator,
  observeLiveCopyAdmissions,
  openLiveCopyGate,
  readLiveCopy,
  readLiveCopyDomain,
  readLiveCopyResult,
} from '../live-copy.ts';

export function createLibraryAccessPorts(): LibraryAccessPorts {
  return {
    deadlineClient,
    within,
    readAccount,
    readAccountCommandState,
    actingCommandAccount,
    commandAccessContext,
    requireCommandAdmission,
    admitGroup,
    captureDurableInitiator,
    durableInitiatorCommitment,
    resourceAuthorization,
    resourceAuthorizationPage,
    createResourcePublicEligibility,
    parentCreationAuthorization,
    initializeResourceGrants,
    readViewerActions,
    createNativeCopyAccountAdmission,
    nativeCopyAccountWork,
    shareAccount,
    fenceOperationalAccount,
    createInitiatorRestorer,
    deriveAccess,
    accessRoot,
    installResourceRoleCatalogue,
    resourceRoleCatalogue,
    readPublicViews,
    readMembershipRouteKey,
    readMembershipWorkConfig,
    isAccessWorkDispatch,
    contributionDeleted,
    readContributionAttributions,
    agentContributionAttribution,
    creationDeclares,
    specializeCollectionList,
    collectionAuthorizationPreparationWork,
    readAccountDiscoverySummaries,
    ACCESS_EVENTS,
    liveCopyLocator,
    readLiveCopy,
    readLiveCopyDomain,
    readLiveCopyResult,
    admitLiveCopyRoles,
    observeLiveCopyAdmissions,
    openLiveCopyGate,
    finishLiveCopyGate,
    cancelLiveCopy,
    consumeLiveCopy,
  };
}
