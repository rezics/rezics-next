import { requestToResourceInput, verifyAccessTokenRequest, verifyJwsAccessToken } from 'better-auth/oauth2';
import type { VerifiedPrincipal } from '../access/admission.ts';

export interface AccountAssertionConfig {
  issuer: string;
  audience: string;
  jwksUrl: string;
  introspectUrl: string;
  clientId: string;
  clientSecret: string;
}

export class AccountAssertionDenied extends Error {}
export class AccountAssertionUnavailable extends Error {}

/**
 * Account owns current session/consent enforcement. A signed token alone does
 * not show that its attached session is still active, so every admission also
 * requires an authoritative introspection response.
 */
export class AccountAssertionVerifier {
  constructor(private readonly config: AccountAssertionConfig) {
    for (const [name, value] of Object.entries(config)) {
      if (!value) throw new Error(`Account assertion ${name} is required`);
    }
  }

  async verify(request: Request, requiredScopes: readonly string[]): Promise<VerifiedPrincipal> {
    const input = requestToResourceInput(request);
    // The first profile accepts bearer JWTs. DPoP needs a shared, persistent
    // proof replay store across Main replicas before it can be admitted.
    const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(input.authorizationHeader ?? '');
    if (!match || input.dpopProofJwt) throw new AccountAssertionDenied('unsupported Account assertion');
    const token = match[1]!;
    const verifyOptions = { issuer: this.config.issuer, audience: this.config.audience };
    let signed;
    try {
      signed = await verifyJwsAccessToken(token, { jwksFetch: this.config.jwksUrl, verifyOptions });
    } catch (error) {
      if (error instanceof TypeError || (error instanceof Error && /Jwks failed|No jwks found/.test(error.message))) {
        throw new AccountAssertionUnavailable('Account signing keys are unavailable');
      }
      throw new AccountAssertionDenied('invalid Account assertion');
    }
    if (signed.iss !== this.config.issuer || typeof signed.sub !== 'string' || signed.sub.length === 0
      || !Number.isSafeInteger(signed.exp) || signed.exp! <= Math.floor(Date.now() / 1000)) {
      throw new AccountAssertionDenied('Account assertion identity or expiry is missing');
    }

    let current;
    try {
      current = await verifyAccessTokenRequest(input, {
        verifyOptions,
        requiredScopes,
        remoteVerify: {
          introspectUrl: this.config.introspectUrl,
          clientId: this.config.clientId,
          clientSecret: this.config.clientSecret,
          force: true,
        },
      });
    } catch (error) {
      if (error instanceof TypeError || (error instanceof Error && (
        'status' in error && error.status === 'INTERNAL_SERVER_ERROR'
      ))) throw new AccountAssertionUnavailable('Account enforcement is unavailable');
      throw new AccountAssertionDenied('Account assertion is inactive or insufficient');
    }
    if (current.iss !== signed.iss || current.sub !== signed.sub) {
      throw new AccountAssertionDenied('Account introspection does not match the signed assertion');
    }
    return { issuer: signed.iss!, subject: signed.sub };
  }
}
