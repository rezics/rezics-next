/** Approval and inspection scopes for exact, time-bounded executable themes. */
export const oauthScopes: readonly string[] = ['theme:approve', 'theme:read'];

/** Every scope in this family sits only in a closed platform group. */
export const closedGroupScopes = oauthScopes;
