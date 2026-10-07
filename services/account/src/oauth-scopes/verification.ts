/** Scopes used by the Verification owner's Claim routes and graph commands. */
export const oauthScopes = [
  'claim:create', 'claim:assess', 'claim:read', 'claim:evidence',
  'claim:challenge', 'claim:lineage', 'claim:reliability',
] as const;

/** Every scope in this family sits only in a closed platform group. */
export const closedGroupScopes = oauthScopes;
