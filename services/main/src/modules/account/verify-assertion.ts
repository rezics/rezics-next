import { requestToResourceInput, verifyJwsAccessToken } from 'better-auth/oauth2';
import type { VerifiedPrincipal } from '../access/admission.ts';

export interface AccountAssertionConfig {
  issuer: string;
  audience: string;
  jwksUrl: string;
  introspectUrl: string;
  clientId: string;
  clientSecret: string;
  /** Bound on each JWKS or introspection exchange with a remote Account. */
  timeoutMs?: number;
}

/** Account-signed consent basis exposed only after current introspection succeeds. */
export interface VerifiedAccountAssertion extends VerifiedPrincipal {
  accountAuthMode?: string;
  accountClientId?: string;
  accountConsentId?: string;
  accountConsentGeneration?: string;
  accountAudiences?: readonly string[];
  accountScopes?: readonly string[];
}

export class AccountAssertionDenied extends Error {}
export class AccountAssertionUnavailable extends Error {}

const DEFAULT_TIMEOUT_MS = 3_000;
// The Account resource profile signs access tokens for 300 seconds. Keep this
// verifier's bounds aligned with Account's signing-key policy.
const ACCESS_TOKEN_SECONDS = 300;
const SIGNING_ALLOWANCE_SECONDS = 5;
type JwksSource = Exclude<Parameters<typeof verifyJwsAccessToken>[1]['jwksFetch'], string>;

/**
 * Account owns current session/consent enforcement. A signed token alone does
 * not show that its attached session is still active, so every admission also
 * requires an authoritative introspection response.
 *
 * Main reaches Account only over its public issuer endpoints; it holds no
 * Account database credential. Each exchange is bounded, so a partitioned or
 * stalled Account fails a protected admission closed within `timeoutMs` per
 * call (at most two calls: a JWKS fetch on a cache miss, then introspection).
 * A refused Main credential, an Account failure or a redirect leaves the
 * token's current state unknown: that is unavailable, never an allow and
 * never a denial attributed to the presented token.
 */
export class AccountAssertionVerifier {
  private readonly timeoutMs: number;

  constructor(private readonly config: AccountAssertionConfig) {
    for (const [name, value] of Object.entries(config)) {
      if (name !== 'timeoutMs' && !value) throw new Error(`Account assertion ${name} is required`);
    }
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new Error('Account assertion timeoutMs must be a positive integer');
    }
  }

  async verify(request: Request, requiredScopes: readonly string[]): Promise<VerifiedAccountAssertion> {
    const input = requestToResourceInput(request);
    // The first profile accepts bearer JWTs. DPoP needs a shared, persistent
    // proof replay store across Main replicas before it can be admitted.
    const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(input.authorizationHeader ?? '');
    if (!match || input.dpopProofJwt) throw new AccountAssertionDenied('unsupported Account assertion');
    const token = match[1]!;
    let signed;
    try {
      // The provider's cache is keyed by this verifier and refetches when a
      // token names a key it has not seen, so a newly activated key verifies
      // at once. A retired key may stay cached here for up to five minutes;
      // Account introspection rejects its tokens from retirement.
      signed = await verifyJwsAccessToken(token, { jwksFetch: () => this.fetchJwks(),
        jwksCacheKey: this, verifyOptions: { issuer: this.config.issuer, audience: this.config.audience } });
    } catch (error) {
      if (error instanceof AccountAssertionUnavailable) throw error;
      throw new AccountAssertionDenied('invalid Account assertion');
    }
    const now = Math.floor(Date.now() / 1000);
    if (signed.iss !== this.config.issuer || typeof signed.sub !== 'string' || signed.sub.length === 0
      || !Number.isSafeInteger(signed.iat) || !Number.isSafeInteger(signed.exp)
      || signed.iat! > now + SIGNING_ALLOWANCE_SECONDS
      || signed.exp! <= now || signed.exp! <= signed.iat!
      || signed.exp! > signed.iat! + ACCESS_TOKEN_SECONDS) {
      throw new AccountAssertionDenied('Account assertion identity or expiry is missing');
    }

    const current = await this.introspect(token);
    if (current.active !== true || current.iss !== signed.iss || current.sub !== signed.sub
      || !audienceIncludes(current.aud, this.config.audience)
      || !Number.isSafeInteger(current.exp) || (current.exp as number) <= now
      || (current.nbf !== undefined && (!Number.isSafeInteger(current.nbf) || (current.nbf as number) > now))
      || current.cnf !== undefined) {
      throw new AccountAssertionDenied('Account assertion is inactive or does not match');
    }
    const granted = typeof current.scope === 'string' ? new Set(current.scope.split(' ')) : new Set();
    if (requiredScopes.some(scope => !granted.has(scope))) {
      throw new AccountAssertionDenied('Account assertion lacks a required scope');
    }
    const aud = typeof signed.aud === 'string' ? [signed.aud]
      : Array.isArray(signed.aud) ? signed.aud.filter((value): value is string => typeof value === 'string') : [];
    return { issuer: signed.iss!, subject: signed.sub,
      currentAssertion: () => this.verify(request, requiredScopes),
      ...(current.email_verified === true && signed.rezics_auth_mode !== 'workload'
        ? { emailVerified: true } : {}),
      accountAuthMode: typeof signed.rezics_auth_mode === 'string' ? signed.rezics_auth_mode : undefined,
      accountClientId: typeof current.client_id === 'string' ? current.client_id : undefined,
      accountConsentId: typeof signed.rezics_consent_id === 'string' ? signed.rezics_consent_id : undefined,
      accountConsentGeneration: typeof signed.rezics_consent_generation === 'string'
        ? signed.rezics_consent_generation : undefined,
      accountAudiences: aud,
      accountScopes: typeof current.scope === 'string' ? current.scope.split(' ').filter(Boolean) : [] };
  }

  private async fetchJwks(): ReturnType<JwksSource> {
    const body = await this.exchange(this.config.jwksUrl, { method: 'GET' },
      'Account signing keys are unavailable');
    if (!Array.isArray(body.keys)) throw new AccountAssertionUnavailable('Account signing keys are unavailable');
    return body as unknown as Awaited<ReturnType<JwksSource>>;
  }

  private introspect(token: string): Promise<Record<string, unknown>> {
    return this.exchange(this.config.introspectUrl, { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.config.clientId,
        client_secret: this.config.clientSecret, token, token_type_hint: 'access_token' }) },
    'Account enforcement is unavailable');
  }

  private async exchange(url: string, init: RequestInit, unavailable: string): Promise<Record<string, unknown>> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      const response = await fetch(url, { ...init, redirect: 'manual', signal,
        headers: { ...init.headers as Record<string, string>, accept: 'application/json' } });
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new AccountAssertionUnavailable(unavailable);
      }
      const body = await response.json() as unknown;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new AccountAssertionUnavailable(unavailable);
      }
      return body as Record<string, unknown>;
    } catch (error) {
      if (error instanceof AccountAssertionUnavailable) throw error;
      throw new AccountAssertionUnavailable(unavailable);
    }
  }
}

function audienceIncludes(audience: unknown, expected: string): boolean {
  return audience === expected || (Array.isArray(audience) && audience.includes(expected));
}
