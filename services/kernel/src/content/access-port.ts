/** Content-owned Access operations, installed by server, worker and test composition.
 * Native function signatures are imported only as types, preserving their generic and opaque evidence contracts.
 * No Access implementation is loaded when Content imports these forwarding functions. */
import type * as NativeAccess from '../access/content-adapter.ts';

export interface ContentAccessPort {
  readonly accessCommandAttempt: typeof NativeAccess.accessCommandAttempt;
  readonly accountStandingCheck: typeof NativeAccess.accountStandingCheck;
  readonly acknowledgeErasure: typeof NativeAccess.acknowledgeErasure;
  readonly admitGroup: typeof NativeAccess.admitGroup;
  readonly captureDurableInitiator: typeof NativeAccess.captureDurableInitiator;
  readonly commandAccessContext: typeof NativeAccess.commandAccessContext;
  readonly createAccess: typeof NativeAccess.createAccess;
  readonly createInitiatorRestorer: typeof NativeAccess.createInitiatorRestorer;
  readonly createResourceAnonymousEligibility: typeof NativeAccess.createResourceAnonymousEligibility;
  readonly createResourceCreationManifest: typeof NativeAccess.createResourceCreationManifest;
  readonly createResourcePublicEligibility: typeof NativeAccess.createResourcePublicEligibility;
  readonly creationDeclares: typeof NativeAccess.creationDeclares;
  readonly deadlineClient: typeof NativeAccess.deadlineClient;
  readonly durableInitiatorCommitment: typeof NativeAccess.durableInitiatorCommitment;
  readonly initializeResourceGrants: typeof NativeAccess.initializeResourceGrants;
  readonly installStandingParentGrant: typeof NativeAccess.installStandingParentGrant;
  readonly notificationAllowed: typeof NativeAccess.notificationAllowed;
  readonly parentCreationAuthorization: typeof NativeAccess.parentCreationAuthorization;
  readonly permissionEvidenceDeadline: typeof NativeAccess.permissionEvidenceDeadline;
  readonly readAccount: typeof NativeAccess.readAccount;
  readonly readAccountDiscoverySummaries: typeof NativeAccess.readAccountDiscoverySummaries;
  readonly readAssignment: typeof NativeAccess.readAssignment;
  readonly readErasureStatus: typeof NativeAccess.readErasureStatus;
  readonly readNativeAccessTime: typeof NativeAccess.readNativeAccessTime;
  readonly readPublicIdentities: typeof NativeAccess.readPublicIdentities;
  readonly readPublicIdentityObservations: typeof NativeAccess.readPublicIdentityObservations;
  readonly readViewerActions: typeof NativeAccess.readViewerActions;
  readonly recordLateErasureItem: typeof NativeAccess.recordLateErasureItem;
  readonly requireCommandAdmission: typeof NativeAccess.requireCommandAdmission;
  readonly resolveLateErasureItem: typeof NativeAccess.resolveLateErasureItem;
  readonly resolveRetention: typeof NativeAccess.resolveRetention;
  readonly resourceAuthorization: typeof NativeAccess.resourceAuthorization;
  readonly resourceAuthorizationPage: typeof NativeAccess.resourceAuthorizationPage;
  readonly verifiedBearerExpiry: typeof NativeAccess.verifiedBearerExpiry;
  readonly within: typeof NativeAccess.within;
}

let bound: ContentAccessPort;

export function bindContentAccess(port: ContentAccessPort): ContentAccessPort {
  bound = port;
  return port;
}

export function contentAccess(): ContentAccessPort {
  return bound;
}

/** Forward at invocation so re-composition never leaves a captured native pool, clock or evaluator. */
function forward<K extends keyof ContentAccessPort>(key: K): ContentAccessPort[K] {
  return ((...args: Parameters<ContentAccessPort[K]>) =>
    Reflect.apply(contentAccess()[key], undefined, args)) as ContentAccessPort[K];
}

export const accessCommandAttempt = forward('accessCommandAttempt');
export const accountStandingCheck = forward('accountStandingCheck');
export const acknowledgeErasure = forward('acknowledgeErasure');
export const admitGroup = forward('admitGroup');
export const captureDurableInitiator = forward('captureDurableInitiator');
export const commandAccessContext = forward('commandAccessContext');
export const createAccess = forward('createAccess');
export const createInitiatorRestorer = forward('createInitiatorRestorer');
export const createResourceAnonymousEligibility = forward('createResourceAnonymousEligibility');
export const createResourceCreationManifest = forward('createResourceCreationManifest');
export const createResourcePublicEligibility = forward('createResourcePublicEligibility');
export const creationDeclares = forward('creationDeclares');
export const deadlineClient = forward('deadlineClient');
export const durableInitiatorCommitment = forward('durableInitiatorCommitment');
export const initializeResourceGrants = forward('initializeResourceGrants');
export const installStandingParentGrant = forward('installStandingParentGrant');
export const notificationAllowed = forward('notificationAllowed');
export const parentCreationAuthorization = forward('parentCreationAuthorization');
export const permissionEvidenceDeadline = forward('permissionEvidenceDeadline');
export const readAccount = forward('readAccount');
export const readAccountDiscoverySummaries = forward('readAccountDiscoverySummaries');
export const readAssignment = forward('readAssignment');
export const readErasureStatus = forward('readErasureStatus');
export const readNativeAccessTime = forward('readNativeAccessTime');
export const readPublicIdentities = forward('readPublicIdentities');
export const readPublicIdentityObservations = forward('readPublicIdentityObservations');
export const readViewerActions = forward('readViewerActions');
export const recordLateErasureItem = forward('recordLateErasureItem');
export const requireCommandAdmission = forward('requireCommandAdmission');
export const resolveLateErasureItem = forward('resolveLateErasureItem');
export const resolveRetention = forward('resolveRetention');
export const resourceAuthorization = forward('resourceAuthorization');
export const resourceAuthorizationPage = forward('resourceAuthorizationPage');
export const verifiedBearerExpiry = forward('verifiedBearerExpiry');
export const within = forward('within');
