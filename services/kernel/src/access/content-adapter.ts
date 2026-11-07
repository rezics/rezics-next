import {
  accessCheck,
  accessExplicitCheck,
  accessCommandAuthorization,
  actorOf,
  prepareReadDecisions,
} from '../request/access.ts';
export type {
  accessCheck,
  accessExplicitCheck,
  accessCommandAuthorization,
  actorOf,
  prepareReadDecisions,
} from '../request/access.ts';
/** Native Access producer for Content's chosen operations. Composition installs it before use. */
import {
  accessCheck,
  accessExplicitCheck,
  accessCommandAuthorization,
  actorOf,
  prepareReadDecisions,
} from '../request/access.ts';
export type {
  accessCheck,
  accessExplicitCheck,
  accessCommandAuthorization,
  actorOf,
  prepareReadDecisions,
} from '../request/access.ts';
import type { ContentAccessPort } from '../content/access-port.ts';
import { readAccount, readPublicIdentities, readPublicIdentityObservations } from './account-data.ts';
export type { readAccount, readPublicIdentities, readPublicIdentityObservations } from './account-data.ts';
import { readAccountDiscoverySummaries } from './account-discovery-source.ts';
export type { readAccountDiscoverySummaries } from './account-discovery-source.ts';
import { accountStandingCheck } from './account-standing.ts';
export type { accountStandingCheck } from './account-standing.ts';
import { verifiedBearerExpiry } from './approved-identity.ts';
export type { verifiedBearerExpiry } from './approved-identity.ts';
import { deadlineClient, readNativeAccessTime, within } from './authenticate.ts';
export type { deadlineClient, readNativeAccessTime, within } from './authenticate.ts';
import { accessCommandAttempt, commandAccessContext, requireCommandAdmission } from './command-admission.ts';
export type { accessCommandAttempt, commandAccessContext, requireCommandAdmission } from './command-admission.ts';
import { readAssignment } from './delegation-commands.ts';
export type { readAssignment } from './delegation-commands.ts';
import { captureDurableInitiator, durableInitiatorCommitment } from './durable-initiator-capture.ts';
export type { captureDurableInitiator, durableInitiatorCommitment } from './durable-initiator-capture.ts';
import { createInitiatorRestorer } from './durable-initiator.ts';
export type { createInitiatorRestorer } from './durable-initiator.ts';
import { createResourceAnonymousEligibility } from './eligibility.ts';
export type { createResourceAnonymousEligibility } from './eligibility.ts';
import {
  acknowledgeErasure,
  readErasureStatus,
  recordLateErasureItem,
  resolveLateErasureItem,
  resolveRetention,
} from './erasure.ts';
export type {
  acknowledgeErasure,
  readErasureStatus,
  recordLateErasureItem,
  resolveLateErasureItem,
  resolveRetention,
} from './erasure.ts';
import { admitGroup } from './gates/admission.ts';
export type { admitGroup } from './gates/admission.ts';
import { createAccess } from './index.ts';
export type { createAccess } from './index.ts';
import { creationDeclares, parentCreationAuthorization } from './parent-creation.ts';
export type { creationDeclares, parentCreationAuthorization } from './parent-creation.ts';
import { permissionEvidenceDeadline } from './permission.ts';
export type { permissionEvidenceDeadline } from './permission.ts';
import { notificationAllowed } from './preferences.ts';
export type { notificationAllowed } from './preferences.ts';
import { createResourcePublicEligibility } from './public-eligibility.ts';
export type { createResourcePublicEligibility } from './public-eligibility.ts';
import { resourceAuthorization, resourceAuthorizationPage } from './resource-authorization.ts';
export type { resourceAuthorization, resourceAuthorizationPage } from './resource-authorization.ts';
import { createResourceCreationManifest } from './creation-manifest.ts';
export type { createResourceCreationManifest } from './creation-manifest.ts';
import { initializeResourceGrants } from './resource-initialization.ts';
export type { initializeResourceGrants } from './resource-initialization.ts';
import { installStandingParentGrant } from './standing-parent.ts';
export type { installStandingParentGrant } from './standing-parent.ts';
import { readViewerActions } from './viewer-actions.ts';
export type { readViewerActions } from './viewer-actions.ts';
export type { PublicIdentity, PublicIdentityObservation } from './account-data.ts';
export type { DurableOperationAnchor, InitiatorRestorer } from './durable-initiator.ts';
export type { ResourceCreationEntry, ResourceCreationPort } from './index.ts';
export type { ViewerActionBindings } from './viewer-actions.ts';

export function createNativeContentAccess(): ContentAccessPort {
  return {
    accessCheck,
    accessExplicitCheck,
    accessCommandAuthorization,
    actorOf,
    prepareReadDecisions,
    accessCommandAttempt,
    accountStandingCheck,
    acknowledgeErasure,
    admitGroup,
    captureDurableInitiator,
    commandAccessContext,
    createAccess,
    createInitiatorRestorer,
    createResourceAnonymousEligibility,
    createResourceCreationManifest,
    createResourcePublicEligibility,
    creationDeclares,
    deadlineClient,
    durableInitiatorCommitment,
    initializeResourceGrants,
    installStandingParentGrant,
    notificationAllowed,
    parentCreationAuthorization,
    permissionEvidenceDeadline,
    readAccount,
    readAccountDiscoverySummaries,
    readAssignment,
    readErasureStatus,
    readNativeAccessTime,
    readPublicIdentities,
    readPublicIdentityObservations,
    readViewerActions,
    recordLateErasureItem,
    requireCommandAdmission,
    resolveLateErasureItem,
    resolveRetention,
    resourceAuthorization,
    resourceAuthorizationPage,
    verifiedBearerExpiry,
    within,
  };
}
