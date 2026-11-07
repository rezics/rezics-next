/** Library consumes Access behaviour through this port; process composition supplies native implementations. */
import type { deadlineClient as NativeDeadlineClient, within as NativeWithin } from '../access/authenticate.ts';
import type {
  readAccount as NativeReadAccount,
  readAccountCommandState as NativeReadAccountCommandState,
} from '../access/account-data.ts';
import type {
  actingCommandAccount as NativeActingCommandAccount,
  commandAccessContext as NativeCommandAccessContext,
  requireCommandAdmission as NativeRequireCommandAdmission,
} from '../access/command-admission.ts';
import type { admitGroup as NativeAdmitGroup } from '../access/gates/admission.ts';
import type {
  captureDurableInitiator as NativeCaptureDurableInitiator,
  durableInitiatorCommitment as NativeDurableInitiatorCommitment,
} from '../access/durable-initiator-capture.ts';
import type {
  resourceAuthorization as NativeResourceAuthorization,
  resourceAuthorizationPage as NativeResourceAuthorizationPage,
} from '../access/resource-authorization.ts';
import type {
  createResourcePublicEligibility as NativeCreateResourcePublicEligibility,
  ResourceEligibilityOptions,
  ResourceEligibilityPrepareContext,
} from '../access/public-eligibility.ts';
import type {
  creationDeclares as NativeCreationDeclares,
  parentCreationAuthorization as NativeParentCreationAuthorization,
} from '../access/parent-creation.ts';
import type { initializeResourceGrants as NativeInitializeResourceGrants } from '../access/resource-initialization.ts';
import type { readViewerActions as NativeReadViewerActions } from '../access/viewer-actions.ts';
import type {
  createNativeCopyAccountAdmission as NativeCreateNativeCopyAccountAdmission,
  nativeCopyAccountWork as NativeCopyAccountWork,
} from '../access/adapters/copy-account.ts';
import type {
  fenceOperationalAccount as NativeFenceOperationalAccount,
  shareAccount as NativeShareAccount,
} from '../access/account-share.ts';
import type { createInitiatorRestorer as NativeCreateInitiatorRestorer } from '../access/durable-initiator.ts';
import type { accessRoot as NativeAccessRoot, deriveAccess as NativeDeriveAccess } from '../access/derived-access.ts';
import type {
  installResourceRoleCatalogue as NativeInstallResourceRoleCatalogue,
  resourceRoleCatalogue as NativeResourceRoleCatalogue,
} from '../access/resource-roles.ts';
import type { readPublicViews as NativeReadPublicViews } from '../access/public-views.ts';
import type {
  readMembershipRouteKey as NativeReadMembershipRouteKey,
  readMembershipWorkConfig as NativeReadMembershipWorkConfig,
} from '../access/membership-work-config.ts';
import type { isAccessWorkDispatch as NativeIsAccessWorkDispatch } from '../access/work.ts';
import type {
  agentContributionAttribution as NativeAgentContributionAttribution,
  contributionDeleted as NativeContributionDeleted,
  readContributionAttributions as NativeReadContributionAttributions,
} from '../access/public-identity.ts';
import type {
  collectionAuthorizationPreparationWork as NativeCollectionAuthorizationPreparationWork,
  specializeCollectionList as NativeSpecializeCollectionList,
} from '../access/adapters/collection-policy.ts';
import type { readAccountDiscoverySummaries as NativeReadAccountDiscoverySummaries } from '../access/account-discovery-source.ts';
import type { ACCESS_EVENTS as NativeAccessEvents } from '../access/events.ts';
import type {
  admitLiveCopyRoles as NativeAdmitLiveCopyRoles,
  cancelLiveCopy as NativeCancelLiveCopy,
  consumeLiveCopy as NativeConsumeLiveCopy,
  finishLiveCopyGate as NativeFinishLiveCopyGate,
  liveCopyLocator as NativeLiveCopyLocator,
  observeLiveCopyAdmissions as NativeObserveLiveCopyAdmissions,
  openLiveCopyGate as NativeOpenLiveCopyGate,
  readLiveCopy as NativeReadLiveCopy,
  readLiveCopyDomain as NativeReadLiveCopyDomain,
  readLiveCopyResult as NativeReadLiveCopyResult,
} from '../access/live-copy.ts';
import { requireLibraryAccess } from './domain-binding.ts';

type ResourceEligibility = ReturnType<typeof NativeCreateResourcePublicEligibility>;

export type LibraryAccessPorts = Readonly<{
  deadlineClient: typeof NativeDeadlineClient;
  within: typeof NativeWithin;
  readAccount: typeof NativeReadAccount;
  readAccountCommandState: typeof NativeReadAccountCommandState;
  actingCommandAccount: typeof NativeActingCommandAccount;
  commandAccessContext: typeof NativeCommandAccessContext;
  requireCommandAdmission: typeof NativeRequireCommandAdmission;
  admitGroup: typeof NativeAdmitGroup;
  captureDurableInitiator: typeof NativeCaptureDurableInitiator;
  durableInitiatorCommitment: typeof NativeDurableInitiatorCommitment;
  resourceAuthorization: typeof NativeResourceAuthorization;
  resourceAuthorizationPage: typeof NativeResourceAuthorizationPage;
  createResourcePublicEligibility: typeof NativeCreateResourcePublicEligibility;
  parentCreationAuthorization: typeof NativeParentCreationAuthorization;
  initializeResourceGrants: typeof NativeInitializeResourceGrants;
  readViewerActions: typeof NativeReadViewerActions;
  createNativeCopyAccountAdmission: typeof NativeCreateNativeCopyAccountAdmission;
  nativeCopyAccountWork: typeof NativeCopyAccountWork;
  shareAccount: typeof NativeShareAccount;
  fenceOperationalAccount: typeof NativeFenceOperationalAccount;
  createInitiatorRestorer: typeof NativeCreateInitiatorRestorer;
  deriveAccess: typeof NativeDeriveAccess;
  accessRoot: typeof NativeAccessRoot;
  installResourceRoleCatalogue: typeof NativeInstallResourceRoleCatalogue;
  resourceRoleCatalogue: typeof NativeResourceRoleCatalogue;
  readPublicViews: typeof NativeReadPublicViews;
  readMembershipRouteKey: typeof NativeReadMembershipRouteKey;
  readMembershipWorkConfig: typeof NativeReadMembershipWorkConfig;
  isAccessWorkDispatch: typeof NativeIsAccessWorkDispatch;
  contributionDeleted: typeof NativeContributionDeleted;
  readContributionAttributions: typeof NativeReadContributionAttributions;
  agentContributionAttribution: typeof NativeAgentContributionAttribution;
  creationDeclares: typeof NativeCreationDeclares;
  specializeCollectionList: typeof NativeSpecializeCollectionList;
  collectionAuthorizationPreparationWork: typeof NativeCollectionAuthorizationPreparationWork;
  readAccountDiscoverySummaries: typeof NativeReadAccountDiscoverySummaries;
  ACCESS_EVENTS: typeof NativeAccessEvents;
  liveCopyLocator: typeof NativeLiveCopyLocator;
  readLiveCopy: typeof NativeReadLiveCopy;
  readLiveCopyDomain: typeof NativeReadLiveCopyDomain;
  readLiveCopyResult: typeof NativeReadLiveCopyResult;
  admitLiveCopyRoles: typeof NativeAdmitLiveCopyRoles;
  observeLiveCopyAdmissions: typeof NativeObserveLiveCopyAdmissions;
  openLiveCopyGate: typeof NativeOpenLiveCopyGate;
  finishLiveCopyGate: typeof NativeFinishLiveCopyGate;
  cancelLiveCopy: typeof NativeCancelLiveCopy;
  consumeLiveCopy: typeof NativeConsumeLiveCopy;
}>;

export const deadlineClient: LibraryAccessPorts['deadlineClient'] = (...args) =>
  requireLibraryAccess().deadlineClient(...args);

export const within: LibraryAccessPorts['within'] = (deadline, work) => requireLibraryAccess().within(deadline, work);

export const readAccount: LibraryAccessPorts['readAccount'] = (...args) => requireLibraryAccess().readAccount(...args);

export const readAccountCommandState: LibraryAccessPorts['readAccountCommandState'] = (...args) =>
  requireLibraryAccess().readAccountCommandState(...args);

export const actingCommandAccount: LibraryAccessPorts['actingCommandAccount'] = (...args) =>
  requireLibraryAccess().actingCommandAccount(...args);

export const commandAccessContext: LibraryAccessPorts['commandAccessContext'] = (...args) =>
  requireLibraryAccess().commandAccessContext(...args);

export const requireCommandAdmission: LibraryAccessPorts['requireCommandAdmission'] = (...args) =>
  requireLibraryAccess().requireCommandAdmission(...args);

export const admitGroup: LibraryAccessPorts['admitGroup'] = (...args) => requireLibraryAccess().admitGroup(...args);

export const captureDurableInitiator: LibraryAccessPorts['captureDurableInitiator'] = (...args) =>
  requireLibraryAccess().captureDurableInitiator(...args);

export const durableInitiatorCommitment: LibraryAccessPorts['durableInitiatorCommitment'] = (...args) =>
  requireLibraryAccess().durableInitiatorCommitment(...args);

export const resourceAuthorization: LibraryAccessPorts['resourceAuthorization'] = (
  input: Parameters<LibraryAccessPorts['resourceAuthorization']>[0],
) => requireLibraryAccess().resourceAuthorization(input);

export const resourceAuthorizationPage: LibraryAccessPorts['resourceAuthorizationPage'] = (...args) =>
  requireLibraryAccess().resourceAuthorizationPage(...args);

/** Preserve nullable prepare evidence and the verifier's narrowed evidence type across the native port. */
export function createResourcePublicEligibility<E extends {}>(
  options: Omit<ResourceEligibilityOptions<E>, 'prepare'> & {
    prepare(context: ResourceEligibilityPrepareContext): Promise<E | null | undefined>;
  },
): ResourceEligibility;
export function createResourcePublicEligibility<E>(options: ResourceEligibilityOptions<E>): ResourceEligibility;
export function createResourcePublicEligibility<E>(options: ResourceEligibilityOptions<E>): ResourceEligibility {
  return requireLibraryAccess().createResourcePublicEligibility(options);
}

export const parentCreationAuthorization: LibraryAccessPorts['parentCreationAuthorization'] = (...args) =>
  requireLibraryAccess().parentCreationAuthorization(...args);

export const initializeResourceGrants: LibraryAccessPorts['initializeResourceGrants'] = (...args) =>
  requireLibraryAccess().initializeResourceGrants(...args);

export const readViewerActions: LibraryAccessPorts['readViewerActions'] = (...args) =>
  requireLibraryAccess().readViewerActions(...args);

export const createNativeCopyAccountAdmission: LibraryAccessPorts['createNativeCopyAccountAdmission'] = (...args) =>
  requireLibraryAccess().createNativeCopyAccountAdmission(...args);

export const nativeCopyAccountWork: LibraryAccessPorts['nativeCopyAccountWork'] = (...args) =>
  requireLibraryAccess().nativeCopyAccountWork(...args);

export const shareAccount: LibraryAccessPorts['shareAccount'] = (...args) =>
  requireLibraryAccess().shareAccount(...args);

export const fenceOperationalAccount: LibraryAccessPorts['fenceOperationalAccount'] = (...args) =>
  requireLibraryAccess().fenceOperationalAccount(...args);

export const createInitiatorRestorer: LibraryAccessPorts['createInitiatorRestorer'] = (...args) =>
  requireLibraryAccess().createInitiatorRestorer(...args);

export const deriveAccess: LibraryAccessPorts['deriveAccess'] = (...args) =>
  requireLibraryAccess().deriveAccess(...args);

export const accessRoot: LibraryAccessPorts['accessRoot'] = (...args) => requireLibraryAccess().accessRoot(...args);

export const installResourceRoleCatalogue: LibraryAccessPorts['installResourceRoleCatalogue'] = (...args) =>
  requireLibraryAccess().installResourceRoleCatalogue(...args);

export const resourceRoleCatalogue: LibraryAccessPorts['resourceRoleCatalogue'] = (...args) =>
  requireLibraryAccess().resourceRoleCatalogue(...args);

export const readPublicViews: LibraryAccessPorts['readPublicViews'] = (...args) =>
  requireLibraryAccess().readPublicViews(...args);

export const readMembershipRouteKey: LibraryAccessPorts['readMembershipRouteKey'] = (...args) =>
  requireLibraryAccess().readMembershipRouteKey(...args);

export const readMembershipWorkConfig: LibraryAccessPorts['readMembershipWorkConfig'] = (...args) =>
  requireLibraryAccess().readMembershipWorkConfig(...args);

export const isAccessWorkDispatch: LibraryAccessPorts['isAccessWorkDispatch'] = () =>
  requireLibraryAccess().isAccessWorkDispatch();

export const contributionDeleted: LibraryAccessPorts['contributionDeleted'] = (...args) =>
  requireLibraryAccess().contributionDeleted(...args);

export const readContributionAttributions: LibraryAccessPorts['readContributionAttributions'] = (...args) =>
  requireLibraryAccess().readContributionAttributions(...args);

export const agentContributionAttribution: LibraryAccessPorts['agentContributionAttribution'] = (...args) =>
  requireLibraryAccess().agentContributionAttribution(...args);

export const creationDeclares: LibraryAccessPorts['creationDeclares'] = (...args) =>
  requireLibraryAccess().creationDeclares(...args);

export const specializeCollectionList: LibraryAccessPorts['specializeCollectionList'] = (...args) =>
  requireLibraryAccess().specializeCollectionList(...args);

export const collectionAuthorizationPreparationWork: LibraryAccessPorts['collectionAuthorizationPreparationWork'] =
  () => requireLibraryAccess().collectionAuthorizationPreparationWork();

export const readAccountDiscoverySummaries: LibraryAccessPorts['readAccountDiscoverySummaries'] = (...args) =>
  requireLibraryAccess().readAccountDiscoverySummaries(...args);

export const ACCESS_EVENTS: LibraryAccessPorts['ACCESS_EVENTS'] = () => requireLibraryAccess().ACCESS_EVENTS();

export const liveCopyLocator: LibraryAccessPorts['liveCopyLocator'] = (...args) =>
  requireLibraryAccess().liveCopyLocator(...args);

export const readLiveCopy: LibraryAccessPorts['readLiveCopy'] = (...args) =>
  requireLibraryAccess().readLiveCopy(...args);

export const readLiveCopyDomain: LibraryAccessPorts['readLiveCopyDomain'] = (...args) =>
  requireLibraryAccess().readLiveCopyDomain(...args);

export const readLiveCopyResult: LibraryAccessPorts['readLiveCopyResult'] = (...args) =>
  requireLibraryAccess().readLiveCopyResult(...args);

export const admitLiveCopyRoles: LibraryAccessPorts['admitLiveCopyRoles'] = (...args) =>
  requireLibraryAccess().admitLiveCopyRoles(...args);

export const observeLiveCopyAdmissions: LibraryAccessPorts['observeLiveCopyAdmissions'] = (...args) =>
  requireLibraryAccess().observeLiveCopyAdmissions(...args);

export const openLiveCopyGate: LibraryAccessPorts['openLiveCopyGate'] = (...args) =>
  requireLibraryAccess().openLiveCopyGate(...args);

export const finishLiveCopyGate: LibraryAccessPorts['finishLiveCopyGate'] = (...args) =>
  requireLibraryAccess().finishLiveCopyGate(...args);

export const cancelLiveCopy: LibraryAccessPorts['cancelLiveCopy'] = (...args) =>
  requireLibraryAccess().cancelLiveCopy(...args);

export const consumeLiveCopy: LibraryAccessPorts['consumeLiveCopy'] = (...args) =>
  requireLibraryAccess().consumeLiveCopy(...args);
