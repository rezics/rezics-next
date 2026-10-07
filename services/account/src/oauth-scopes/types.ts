/** Token consent is separate from Access's administrator admission grant. */
export const oauthScopes = ['type:admit'] as const;

/** Every scope in this family sits only in a closed platform group. */
export const closedGroupScopes = oauthScopes;
