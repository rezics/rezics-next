/** Bearer scopes for governance poll administration, ballot operation, invalidation and reads. */
export const oauthScopes = ['vote:manage', 'vote:cast', 'vote:invalidate', 'vote:read'] as const;

/** Every scope in this family sits only in a closed platform group. */
export const closedGroupScopes = oauthScopes;
