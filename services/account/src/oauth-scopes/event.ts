/** Read and submit Event time observations through the Main owner. */
export const oauthScopes = ['event:submit', 'event:read'] as const;

/** Every scope in this family sits only in a closed platform group. */
export const closedGroupScopes = oauthScopes;
