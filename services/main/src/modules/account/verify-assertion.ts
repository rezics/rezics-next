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
  /** Signed and introspected token expiry, in Unix seconds. Budget attribution only. */
  accountExpiresAt?: number;
  accountDisplayName?: string;
  accountAuthMode?: string;
  accountClientId?: string;
  accountConsentId?: string;
  accountConsentGeneration?: string;
  accountAudiences?: readonly string[];
  accountScopes?: readonly string[];
}

export class AccountAssertionDenied extends Error {}
/** Authentication succeeded, but the token lacks the operation's scope. */
export class AccountAssertionInsufficientScope extends AccountAssertionDenied {}
export class AccountAssertionUnavailable extends Error {}

interface RequestAdmission { scopes: readonly string[]; principal: VerifiedAccountAssertion }
/** Account admission for this Request, taken by its first read session.
 * A retry session finds nothing here and verifies again, so a revocation
 * between attempts is seen. Nothing is keyed by the bearer. */
const requestAdmissions = new WeakMap<Request, RequestAdmission>();

/** A command verifies its full consent now, then hands that same admission to
 * its effect-free Work read. The read consumes it once; another request or a
 * retry verifies again. No budget-attribution cache authorizes the command. */
export async function verifyCommandAccount(
  account: Pick<AccountAssertionVerifier, 'verify'>,
  request: Request,
  requiredScopes: readonly string[],
): Promise<VerifiedAccountAssertion> {
  // A failed command must not leave an earlier rate-limit grant available.
  requestAdmissions.delete(request);
  const principal = await account.verify(request, requiredScopes);
  requestAdmissions.set(request, { scopes: requiredScopes, principal });
  return principal;
}

function grantCovers(admission: RequestAdmission, requiredScopes: readonly string[]): boolean {
  // A published grant is the introspection result. A verifier that omits it
  // enforced only the scopes of the call that produced the admission.
  const grant = admission.principal.accountScopes;
  const admitted = grant ?? admission.scopes;
  return requiredScopes.every(scope => admitted.includes(scope));
}

/** Hand the rate-limit admission to the first read session of this Request.
 * That session consumes it. A later attempt on the same Request verifies again. */
export async function verifyRequestAccount(
  account: Pick<AccountAssertionVerifier, 'verify'>,
  request: Request,
  requiredScopes: readonly string[],
): Promise<VerifiedAccountAssertion> {
  const existing = requestAdmissions.get(request);
  if (existing) {
    if (grantCovers(existing, requiredScopes)) {
      if (requiredScopes.length > 0) requestAdmissions.delete(request);
      return existing.principal;
    }
    if (existing.principal.accountScopes) {
      throw new AccountAssertionInsufficientScope('Account assertion lacks a required scope');
    }
  }
  const principal = await account.verify(request, requiredScopes);
  // This path stores only rate-limit checks. Commands explicitly hand off
  // their admission above; a read's verification cannot cover its next attempt.
  if (requiredScopes.length === 0 && !requestAdmissions.has(request)) {
    requestAdmissions.set(request, { scopes: requiredScopes, principal });
  }
  return principal;
}

const DEFAULT_TIMEOUT_MS = 3_000;
// The Account resource profile signs access tokens for 300 seconds. Keep this
// verifier's bounds aligned with Account's signing-key policy.
const ACCESS_TOKEN_SECONDS = 300;
const SIGNING_ALLOWANCE_SECONDS = 5;
export const ACCOUNT_KEY_CACHE_MS = 300_000;
export const ACCOUNT_KEY_RETRY_MS = 30_000;
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
  private keys?: { until: number; pending: ReturnType<JwksSource> };

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
    request.signal.throwIfAborted();
    const input = requestToResourceInput(request);
    // The first profile accepts bearer JWTs. DPoP needs a shared, persistent
    // proof replay store across Main replicas before it can be admitted.
    const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(input.authorizationHeader ?? '');
    if (!match || input.dpopProofJwt) throw new AccountAssertionDenied('unsupported Account assertion');
    const token = match[1]!;
    let signed;
    try {
      // Own the refresh clock: the provider's kid-driven cache lets arbitrary
      // forged key IDs trigger outbound work. Account publishes staged keys
      // for this cache lifetime before activation; introspection enforces retirement.
      signed = await verifyJwsAccessToken(token, { jwksFetch: () => this.fetchJwks(),
        verifyOptions: { issuer: this.config.issuer, audience: this.config.audience } });
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

    // A shared signing-key refresh may drain for other readers. This request
    // must not start introspection after its caller has left.
    request.signal.throwIfAborted();
    const current = await this.introspect(token, request.signal);
    if (current.active !== true || current.iss !== signed.iss || current.sub !== signed.sub
      || !audienceIncludes(current.aud, this.config.audience)
      || !Number.isSafeInteger(current.exp) || (current.exp as number) <= now
      || (current.nbf !== undefined && (!Number.isSafeInteger(current.nbf) || (current.nbf as number) > now))
      || current.cnf !== undefined) {
      throw new AccountAssertionDenied('Account assertion is inactive or does not match');
    }
    const granted = typeof current.scope === 'string' ? new Set(current.scope.split(' ')) : new Set();
    if (requiredScopes.some(scope => !granted.has(scope))) {
      throw new AccountAssertionInsufficientScope('Account assertion lacks a required scope');
    }
    const aud = typeof signed.aud === 'string' ? [signed.aud]
      : Array.isArray(signed.aud) ? signed.aud.filter((value): value is string => typeof value === 'string') : [];
    return { issuer: signed.iss!, subject: signed.sub, accountExpiresAt: signed.exp,
      ...(signed.rezics_auth_mode !== 'workload'
        ? { contentEvidence: parseContentEvidence(current.rezics_content_evidence) } : {}),
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

  private fetchJwks(): ReturnType<JwksSource> {
    if (this.keys && Date.now() < this.keys.until) return this.keys.pending;
    // One shared promise bounds cold-start bursts and failed exchanges too.
    // No attacker-controlled key IDs are retained.
    const entry: { until: number; pending: ReturnType<JwksSource> } = {
      until: Infinity, pending: this.exchange(this.config.jwksUrl, { method: 'GET' },
        'Account signing keys are unavailable').then(body => {
        if (!Array.isArray(body.keys)) throw new AccountAssertionUnavailable('Account signing keys are unavailable');
        entry.until = Date.now() + ACCOUNT_KEY_CACHE_MS;
        return body as unknown as Awaited<ReturnType<JwksSource>>;
      }).catch((error: unknown) => {
        entry.until = Date.now() + ACCOUNT_KEY_RETRY_MS;
        throw error;
      }),
    };
    this.keys = entry;
    return entry.pending;
  }

  private introspect(token: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    return this.exchange(this.config.introspectUrl, { method: 'POST',
      signal,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.config.clientId,
        client_secret: this.config.clientSecret, token, token_type_hint: 'access_token' }) },
    'Account enforcement is unavailable');
  }

  private async exchange(url: string, init: RequestInit, unavailable: string): Promise<Record<string, unknown>> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = init.signal ? AbortSignal.any([timeout, init.signal]) : timeout;
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

function parseContentEvidence(value: unknown): VerifiedPrincipal['contentEvidence'] {
  if (value === undefined) return undefined;
  const body = value as Record<string, unknown> | null;
  const categories = body?.categories as Record<string, unknown> | null;
  if (!body || !['unknown', 'under-15', '15-17', 'adult'].includes(String(body.age))
    || !(body.country === null || typeof body.country === 'string' && /^[A-Z]{2}$/.test(body.country))
    || typeof body.accountEligible !== 'boolean' || typeof body.adultAvailable !== 'boolean'
    || body.nsfwDisplay !== undefined && !['mask', 'show'].includes(String(body.nsfwDisplay))
    || !categories || ['general', 'r15', 'r18', 'r18g'].some(key => typeof categories[key] !== 'boolean'))
    throw new AccountAssertionUnavailable('Account content evidence is invalid');
  return { age: body.age as NonNullable<VerifiedPrincipal['contentEvidence']>['age'],
    country: body.country as string | null, accountEligible: body.accountEligible,
    adultAvailable: body.adultAvailable, categories: {
      general: categories.general as boolean, r15: categories.r15 as boolean,
      r18: categories.r18 as boolean, r18g: categories.r18g as boolean },
    nsfwDisplay: body.nsfwDisplay === 'show' ? 'show' : 'mask' };
}
