import {
  ACCESS_MEMBERSHIP_INVERSE_LIMIT,
  type AccessApplication,
  type AccessApplicationPorts,
} from '../contract/index.ts';
import { createAvatarQualification } from './avatar-qualification.ts';
import { createIdentityRecovery } from './identity-recovery.ts';
import { createIdentityRetention } from './identity-retention.ts';
import { createKindAudienceApplication } from './kind-audience.ts';
import { createOriginalAdmission } from './original-admission.ts';
import { createRealmAdministration } from './realm-administration.ts';
import { createResourceAuthorizationApplication } from './resource-authorization.ts';

/** Use cases over Access-owned ports. Downstream implementations are never imported here. */
export function createAccessApplication(
  ports: AccessApplicationPorts,
  options: { membershipLimit?: number } = {},
): AccessApplication {
  const membershipLimit = options.membershipLimit ?? ACCESS_MEMBERSHIP_INVERSE_LIMIT;
  const avatar = createAvatarQualification(ports);
  const realm = createRealmAdministration(ports);
  const identity = createIdentityRecovery(ports);
  const retention = createIdentityRetention(ports);
  const kindAudience = createKindAudienceApplication(ports, membershipLimit);
  const originalWork = createOriginalAdmission(ports);
  const authorization = createResourceAuthorizationApplication(ports);
  return Object.freeze({
    ports,
    qualifyAvatar: avatar.qualifyAvatar,
    readAvatarSummaries: avatar.readAvatarSummaries,
    approveRealmClaim: realm.approveRealmClaim,
    recoverIdentitySource: identity.recoverIdentitySource,
    retainIdentitySource: retention.retainIdentitySource,
    planKindAudience: kindAudience.plan,
    resolveKindAudienceRawInput: kindAudience.resolveRawInput,
    admitOriginalWork: originalWork.admit,
    originalWorkDeadlineMs: originalWork.deadlineMs,
    originalWorkLocalAllowance: originalWork.localAllowance,
    decideAuthorization: authorization.decide,
    authorizeResource: authorization.authorize,
  });
}
