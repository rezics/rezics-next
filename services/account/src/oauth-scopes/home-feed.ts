/** Private follows and public feed votes have separate OAuth ceilings. */
export const oauthScopes = ['follow:read', 'follow:write', 'feed:vote'] as const;
