/** Account scopes consumed by Main's connected-app API admission boundary. */
export const oauthScopes = [
  'connected-app:observe',
  'connected-app:consent',
  'connected-app:invoke',
  'connected-app:read',
];

/** Every scope in this family sits only in a closed platform group. */
export const closedGroupScopes = oauthScopes;
