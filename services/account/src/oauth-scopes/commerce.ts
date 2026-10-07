/** Bearer scopes already required by Main's Commerce owner routes. */
export const oauthScopes = ['subscription:manage', 'quota:reserve'] as const;

/** Every scope in this family sits only in a closed platform group. */
export const closedGroupScopes = oauthScopes;
