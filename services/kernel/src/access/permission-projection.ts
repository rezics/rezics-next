/** Closed primitive evidence returned by the bounded permission SQL. False is
 * the longest JSON encoding of boolean | null and reserves every returned key.
 */
export const nativePermissionProjectionBound = Object.freeze({
  assignmentValid: false,
  deadlineLive: false,
  localDenied: false,
  actorActionGrant: false,
  actorResourceRoleGrant: false,
  actorOwnAccountGrant: false,
  actorAuthenticatedBenefitGrant: false,
  principalActionGrant: false,
  principalResourceRoleGrant: false,
  principalOwnAccountGrant: false,
  principalAuthenticatedBenefitGrant: false,
  globalDenied: false,
  globalActorActionGrant: false,
  globalActorResourceRoleGrant: false,
  globalActorOwnAccountGrant: false,
  globalActorAuthenticatedBenefitGrant: false,
  globalPrincipalActionGrant: false,
  globalPrincipalResourceRoleGrant: false,
  globalPrincipalOwnAccountGrant: false,
  globalPrincipalAuthenticatedBenefitGrant: false,
  explicitLocalDenied: false,
  explicitActorActionGrant: false,
  explicitActorResourceRoleGrant: false,
  explicitActorOwnAccountGrant: false,
  explicitActorAuthenticatedBenefitGrant: false,
  explicitPrincipalActionGrant: false,
  explicitPrincipalResourceRoleGrant: false,
  explicitPrincipalOwnAccountGrant: false,
  explicitPrincipalAuthenticatedBenefitGrant: false,
  explicitGlobalDenied: false,
  explicitGlobalActorActionGrant: false,
  explicitGlobalActorResourceRoleGrant: false,
  explicitGlobalActorOwnAccountGrant: false,
  explicitGlobalActorAuthenticatedBenefitGrant: false,
  explicitGlobalPrincipalActionGrant: false,
  explicitGlobalPrincipalResourceRoleGrant: false,
  explicitGlobalPrincipalOwnAccountGrant: false,
  explicitGlobalPrincipalAuthenticatedBenefitGrant: false,
});

export type NativePermissionProjection = Readonly<{
  [K in keyof typeof nativePermissionProjectionBound]: boolean | null;
}>;
