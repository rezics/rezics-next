import { oauthProvider } from '@better-auth/oauth-provider';

/** Native models resolve to the existing, single client and consent authority. */
export const websiteSchema = {
  oauthClient: {
    modelName: 'auth_client',
    fields: { clientId: 'client_id', skipConsent: 'first_party' },
  },
  oauthConsent: {
    modelName: 'auth_consent',
    fields: { userId: 'account_id', clientId: 'client_id' },
  },
};

/**
 * The official provider, configured for the confidential website client only.
 * The API resource row and its client link are written by website registration,
 * so the provider seeds no resources at startup.
 */
export function websiteProvider(scopes: string[], claims?: () => Promise<Record<string, unknown>>) {
  return oauthProvider({
    schema: websiteSchema,
    loginPage: '/login',
    consentPage: '/consent',
    scopes,
    grantTypes: ['authorization_code', 'refresh_token'],
    assertionMaxLifetime: 120,
    accessTokenExpiresIn: 300,
    idTokenExpiresIn: 300,
    codeExpiresIn: 120,
    refreshTokenReuseInterval: 0,
    allowDynamicClientRegistration: false,
    allowUnauthenticatedClientRegistration: false,
    allowClientKeyRotation: false,
    clientPrivileges: () => false,
    resourcePrivileges: () => false,
    validateRedirectUri: (uri, registeredUris) => registeredUris.includes(uri),
    ...(claims ? { customAccessTokenClaims: claims } : {}),
    authenticationContext: {
      acrValuesSupported: ['0'],
      resolve: ({ session }) => ({ amr: String(session.authMethods).split(' ') }),
    },
  });
}
