/** Package installation, recommendation editing and artifact revocation scopes. */
export const oauthScopes = ['package:install', 'package:revoke', 'package:recommendation-set'] as const;

/** Every scope in this family sits only in a closed platform group. */
export const closedGroupScopes = oauthScopes;
