import { betterAuth } from 'better-auth';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { APIError, createAuthMiddleware, createEmailVerificationToken, getSessionFromCtx } from 'better-auth/api';
import { jwtVerify } from 'jose';
import { captcha, jwt, openAPI, twoFactor } from 'better-auth/plugins';
import { getAuthenticatorName, passkey } from '@better-auth/passkey';
import { oauthProvider } from '@better-auth/oauth-provider';
import { Pool } from 'pg';
import { AUTH_MODE_CLAIM, CONSENT_CLAIM, CONSENT_GENERATION_CLAIM,
  currentAuthorizationCodeBasis } from './consent-fence.ts';
import { currentInstallationIn, INSTALLATION_CLAIM } from './installations.ts';
import { signingKeyOptions } from './signing-keys.ts';
import { providerScopes, resourceScopes } from './oauth-scopes.ts';
import { currentRecoveryGeneration, RECOVERY_GENERATION_CLAIM } from './recovery-claim.ts';
import type { AccountEmail } from './email.ts';
import { afterPasskeyAssertion, languageForSignupEmail, localeField, markEmailChangeStep,
  passkeyRelyingParty, recipientLocale, takeSignupRequestLocale } from './account-settings.ts';
import { deviceLabel } from './security-activity.ts';
import { ACCOUNT_GENERATION_CLAIM, GRANT_GENERATION_CLAIM, currentAccountGenerations } from './account-fence.ts';
import { bootstrapOperators, operatorRole, rolePermits } from './operators.ts';
import { operatorAuthHooks } from './operator-auth-hooks.ts';
import { beforeSessionDelete } from './first-party-session.ts';
import { consumeAccountLimit } from './rate-limit.ts';
import { signupPolicyInput, policyAcceptanceRequired } from './policy-acceptance.ts';
import { SignupPolicyProblem } from './market-policy.ts';
import type { PolicyVersion } from './policy-versions.ts';

export const AGENT_REGISTRATION_BUDGET = Object.freeze({ maximum: 10, seconds: 300 });
const enrollmentEndpoints = ['/sign-up/email', '/request-password-reset', '/send-verification-email'];

export interface AccountConfig {
  baseURL: string;
  secret: string;
  resource: string;
  pool: Pool;
  operatorUserIds: ReadonlySet<string>;
  email?: AccountEmail;
  /** The HTTP process requires verification. Embedded protocol fixtures without a sender can omit it. */
  requireEmailVerification?: boolean;
  /** Required by the HTTP process; protocol fixtures without enrollment may omit it. */
  turnstileSecretKey?: string;
  turnstileMode?: 'local' | 'cloudflare';
  /** Embedded tests can substitute a local verifier; never configured by the HTTP process. */
  turnstileVerifyURL?: string;
  accessDeletionFence?: (accountSubject: string) => Promise<void>;
  /** Embedded fixtures can exercise a material policy update. */
  policyVersions?: readonly PolicyVersion[];
}

type EmailUser = { id: string; email: string; locale?: unknown };

/** Registration is only a ceiling. Installation and explicit consent still
 * bind issuance, and Main still selects/checks the acting Agent per operation. */
export function agentRegistrationScopes(): string[] {
  const document = JSON.parse(readFileSync(new URL('../../../generated/openapi/main/public.json',
    import.meta.url), 'utf8')) as { paths: Record<string, Record<string, {
      'x-rezics-capability'?: { mcp?: { scopes: string[] } } }>> };
  const scopes = new Set<string>(['openid', 'offline_access']);
  for (const methods of Object.values(document.paths)) for (const operation of Object.values(methods)) {
    const mcp = operation['x-rezics-capability']?.mcp;
    if (mcp) {
      if (!Array.isArray(mcp.scopes)) throw new Error('Declared agent OAuth scopes are required');
      for (const scope of mcp.scopes) scopes.add(scope);
    }
  }
  if ([...scopes].some(scope => !providerScopes.includes(scope))) throw new Error('Unknown declared agent OAuth scope');
  return [...scopes].sort();
}

export function accountAuthOptions(config: AccountConfig) {
  const agentScopes = agentRegistrationScopes();
  const operatorHooks = operatorAuthHooks(config.pool, config.operatorUserIds);
  const requireEmailVerification = config.requireEmailVerification ?? !!config.email;
  if (config.secret.length < 32) throw new Error('ACCOUNT_SECRET must contain at least 32 characters');
  const resource = new URL(config.resource);
  if (resource.hash || !['http:', 'https:'].includes(resource.protocol)) {
    throw new Error('ACCOUNT_RESOURCE must be an absolute HTTP(S) URL without a fragment');
  }
  return {
    policyVersions: config.policyVersions,
    baseURL: config.baseURL,
    secret: config.secret,
    database: config.pool,
    advanced: { ipAddress: { ipAddressHeaders: ['x-rezics-client-ip'] } },
    // The HTTP boundary checks our session-bound reauthentication proof. The
    // provider's age-only check cannot recognize that proof after step-up.
    session: { freshAge: 0 },
    hooks: { ...operatorHooks, before: createAuthMiddleware(async ctx => {
      if (ctx.path === '/verify-email' && typeof ctx.query?.token === 'string') {
        // Email verification links are stateless JWTs, so deleting verification
        // rows cannot revoke them. Bind new links to the same recovery generation.
        const verified = await jwtVerify(ctx.query.token, new TextEncoder().encode(config.secret),
          { algorithms: ['HS256'] }).catch(() => null);
        // Let the provider keep its normal invalid/expired-link redirects.
        const user = typeof verified?.payload.email === 'string'
          ? (await config.pool.query<{ id: string }>('SELECT id FROM public."user" WHERE email = $1',
            [verified.payload.email])).rows[0] : undefined;
        if (user && (verified!.payload[RECOVERY_GENERATION_CLAIM] ?? '0')
          !== await currentRecoveryGeneration(config.pool, user.id)) {
          // This hook precedes the provider's origin middleware. Redirect only
          // to this issuer; never let an invalidated link become an open redirect.
          if (typeof ctx.query.callbackURL === 'string') {
            const callback = new URL(ctx.query.callbackURL, config.baseURL);
            if (callback.origin === new URL(config.baseURL).origin) {
              callback.searchParams.set('error', 'INVALID_TOKEN');
              throw ctx.redirect(callback.toString());
            }
          }
          throw new APIError('FORBIDDEN', {
            code: 'INVALID_TOKEN',
            message: 'Verification link is unavailable',
          });
        }
      }
      if (ctx.path === '/sign-up/email') {
        try { signupPolicyInput(ctx.body as Record<string, unknown>,
          ctx.headers?.get('x-rezics-request-country'), config.policyVersions); }
        catch (error) {
          if (!(error instanceof SignupPolicyProblem)) throw error;
          throw new APIError('BAD_REQUEST', { code: error.reason, reason: error.reason,
            minimumAge: error.minimumAge, message: error.reason });
        }
      }
      // Better Auth runs plugin onRequest verification before endpoint hooks.
      // Charging here keeps failed challenges out of a caller-selected target's
      // budget, including embedded clients that bypass the HTTP app adapter.
      if (enrollmentEndpoints.includes(ctx.path)) {
        const body = ctx.body as { email?: unknown } | undefined;
        const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
        if (email && email.length <= 320) {
          let admitted: boolean;
          try { admitted = await consumeAccountLimit(config.pool, config.secret,
            `/api/auth${ctx.path}:${email}`, 3, 300); }
          catch { throw new APIError('SERVICE_UNAVAILABLE', { error: 'temporarily_unavailable' }); }
          if (!admitted) throw new APIError('TOO_MANY_REQUESTS', { error: 'rate_limited' },
            { 'Retry-After': '300' });
        }
      }
      if (ctx.path === '/oauth2/authorize') {
        const session = await getSessionFromCtx(ctx);
        if (session && await policyAcceptanceRequired(config.pool, session.user.id, config.policyVersions)) {
          throw new APIError('FORBIDDEN', { code: 'policy_acceptance_required', message: 'Accept the current policies' });
        }
      }
      if (ctx.path === '/oauth2/register') {
        const body = ctx.body as Record<string, unknown>;
        const grants = body.grant_types ?? ['authorization_code'];
        if (body.token_endpoint_auth_method !== 'none' || body.subject_type === 'pairwise'
          || !Array.isArray(grants) || !grants.includes('authorization_code')
          || grants.some(grant => grant !== 'authorization_code' && grant !== 'refresh_token')
          || body.client_credentials_scopes !== undefined || body.jwks !== undefined || body.jwks_uri !== undefined
          || ['logo_uri', 'client_uri', 'policy_uri', 'tos_uri'].some(field => body[field] !== undefined)) {
          throw new APIError('BAD_REQUEST', { error: 'invalid_client_metadata',
            error_description: 'Agent registration requires a public authorization-code client with PKCE' });
        }
        // The HTTP boundary replaces this header using the socket peer or a configured proxy.
        // Embedded calls without an address share a fail-closed budget.
        const address = ctx.headers?.get('x-rezics-client-ip') ?? 'unknown';
        let admitted: boolean;
        try { admitted = await consumeAccountLimit(config.pool, config.secret, `oauth-register:${address}`,
          AGENT_REGISTRATION_BUDGET.maximum, AGENT_REGISTRATION_BUDGET.seconds); }
        catch { throw new APIError('SERVICE_UNAVAILABLE', { error: 'temporarily_unavailable' }, { 'Retry-After': '5' }); }
        if (!admitted) throw new APIError('TOO_MANY_REQUESTS', { error: 'rate_limited' },
          { 'Retry-After': String(AGENT_REGISTRATION_BUDGET.seconds) });
      }
      await operatorHooks.before(ctx);
    }) },
    databaseHooks: { user: { create: {
      before: async (user: Record<string, unknown>, context: { path?: string; body?: Record<string, unknown>; headers?: Headers } | null) => {
        if (context?.path !== '/sign-up/email') return { data: user };
        return { data: { ...user, ...signupPolicyInput(context.body ?? {},
          context.headers?.get('x-rezics-request-country'), config.policyVersions) } };
      }, after: async (user: { id: string }, context: { request?: Request } | null) => {
        const locale = takeSignupRequestLocale(user.id, context?.request);
        await config.pool.query(`UPDATE "user" SET signup_locale = $2 WHERE id = $1 AND signup_locale IS NULL`, [user.id, locale]);
    } } }, session: { create: { before: async (session: { userId: string }) => {
      const blocked = await config.pool.query(`SELECT 1 FROM rezics_account_security WHERE user_id = $1
        AND (deletion_started_at IS NOT NULL OR password_reset_required OR (suspended_at IS NOT NULL AND (suspended_until IS NULL OR suspended_until > now())))`, [session.userId]);
      if (blocked.rowCount) {
        throw new APIError('FORBIDDEN', { code: 'ACCOUNT_UNAVAILABLE', message: 'Sign-in is unavailable for this account' });
      }
      return { data: session };
    } }, delete: { before: (session: { id: string; userId: string }, context: { path?: string } | null) =>
      beforeSessionDelete(config.pool, session, context) } } },
    emailAndPassword: { enabled: true,
      requireEmailVerification,
      minPasswordLength: 12,
      resetPasswordTokenExpiresIn: 1800,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }: { user: EmailUser; url: string }, request?: Request) => {
        if (!config.email) throw new Error('Account email delivery is not configured');
        await config.email.enqueue({ userId: user.id, to: user.email, url,
          purpose: 'reset', locale: await recipientLocale(config.pool, user.id) })
          .catch(() => console.error('Account email intent unavailable'));
      },
    },
    emailVerification: { sendOnSignUp: true, autoSignInAfterVerification: true, expiresIn: 1800,
      sendVerificationEmail: async ({ user, url }: { user: EmailUser; url: string }, request?: Request) => {
        if (!config.email && !requireEmailVerification) return;
        if (!config.email) throw new Error('Account email delivery is not configured');
        const bound = new URL(url);
        bound.searchParams.set('token', await createEmailVerificationToken(config.secret, user.email,
          undefined, 1800, { [RECOVERY_GENERATION_CLAIM]: await currentRecoveryGeneration(config.pool, user.id) }));
        await config.email.enqueue({ userId: user.id, to: user.email, url: markEmailChangeStep(bound.toString(), 'verified'),
          purpose: 'verify', locale: await languageForSignupEmail(config.pool, user, request) })
          .catch(() => console.error('Account email intent unavailable'));
      },
    },
    // emailChangeApi owns the durable two-mailbox flow. Provider change tokens
    // carry mutable email addresses and cannot be revoked with account recovery.
    user: { additionalFields: { locale: localeField,
      registrationPolicyVersion: { type: 'string', fieldName: 'registration_policy_version', required: false, input: false, returned: false } as const,
      signupPolicies: { type: 'json', fieldName: 'signup_policies', required: false, input: false, returned: false } as const,
    }, changeEmail: { enabled: false },
      deleteUser: { enabled: !!config.accessDeletionFence,
      beforeDelete: async (user: { id: string }) => {
        if (await operatorRole(config.pool, user.id)) {
          throw new APIError('CONFLICT', { message: 'transfer operator responsibility before deletion' });
        }
        const ownedClient = await config.pool.query(
          'SELECT 1 FROM "oauthClient" WHERE "userId" = $1 LIMIT 1', [user.id]);
        if (ownedClient.rowCount) {
          throw new APIError('CONFLICT', { message: 'transfer OAuth clients before deletion' });
        }
        const recoveryDuty = await config.pool.query(`SELECT 1 FROM
          public.rezics_account_recovery_policy WHERE guardian_user_id = $1 LIMIT 1`, [user.id]);
        if (recoveryDuty.rowCount) {
          throw new APIError('CONFLICT', { message: 'transfer Account recovery duty before deletion' });
        }
        try {
          await config.accessDeletionFence!(user.id);
          // Better Auth deletes credential rows before the user row. Mark the
          // fenced deletion so last-method protection permits only that path.
          await config.pool.query(`UPDATE rezics_account_security SET deletion_started_at = now(), generation = generation + 1
            WHERE user_id = $1 AND deletion_started_at IS NULL`, [user.id]);
        }
        catch { throw new APIError('SERVICE_UNAVAILABLE',
          { message: 'Account deletion awaits the Access fence and retained deletion journal' }); }
      },
    } },
    plugins: [
      enrollmentChallenge(config),
      openAPI({ disableDefaultReference: true }),
      twoFactor({ issuer: 'REZICS', allowPasswordless: true,
        backupCodeOptions: { storeBackupCodes: 'encrypted' } }),
      passkey({ rpName: 'REZICS', ...passkeyRelyingParty(config.baseURL),
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        registration: { afterVerification: async ({ ctx, verification, user }) => {
          if (!verification.registrationInfo?.userVerified) {
            throw new APIError('FORBIDDEN', { code: 'USER_VERIFICATION_REQUIRED', message: 'Verify on your device' });
          }
          const count = await config.pool.query<{ count: number }>(
            'SELECT count(*)::int AS count FROM passkey WHERE "userId" = $1', [user.id]);
          if (count.rows[0]!.count >= 32) throw new APIError('CONFLICT', { message: 'Passkey limit reached' });
          // Unnamed passkeys are called after their provider, else the device
          // that created them; a name the person typed always wins.
          const device = deviceLabel(ctx.headers?.get('user-agent'));
          const name = getAuthenticatorName(verification.registrationInfo.aaguid)
            ?? (device.browser === 'unknown' ? undefined : device.label);
          return name ? { name } : {};
        } },
        authentication: { afterVerification: async ({ verification, clientData }) => {
          if (!verification.authenticationInfo.userVerified) {
            throw new APIError('FORBIDDEN', { code: 'USER_VERIFICATION_REQUIRED', message: 'Verify on your device' });
          }
          await afterPasskeyAssertion(config.pool, clientData.id, verification.authenticationInfo.newCounter);
        } },
      }),
      jwt(signingKeyOptions(config.pool)),
      oauthProvider({
        loginPage: '/sign-in',
        consentPage: '/consent',
        // The signed authorization request lets /sign-in name the App before
        // anyone signs in; the client's public fields are all it reveals.
        allowPublicClientPrelogin: true,
        scopes: [...providerScopes],
        resources: [{ identifier: config.resource,
          allowedScopes: [...resourceScopes], accessTokenTtl: 300 }],
        clientRegistrationDefaultResources: [config.resource],
        clientRegistrationAllowedResources: [config.resource],
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientRegistrationRequirePKCE: true,
        clientRegistrationDefaultScopes: agentScopes,
        clientRegistrationAllowedScopes: [],
        storeTokens: 'hashed',
        // Account's token boundary serializes a rotation and rechecks the live
        // authority before returning any cached response. Ten seconds covers
        // simultaneous isolates without making a stale token reusable later.
        refreshTokenReuseInterval: 10,
        accessTokenExpiresIn: 300,
        clientPrivileges: async ({ user }) => {
          if (!user) return false;
          await bootstrapOperators(config.pool, config.operatorUserIds);
          const role = await operatorRole(config.pool, user.id);
          return !!role && rolePermits(role, 'clients:manage');
        },
        resourcePrivileges: async ({ user }) => {
          if (!user) return false;
          await bootstrapOperators(config.pool, config.operatorUserIds);
          const role = await operatorRole(config.pool, user.id);
          return !!role && rolePermits(role, 'clients:manage');
        },
        extensions: [{ claims: { accessToken: async ({ ctx, user, client, scopes, resources,
          referenceId, grantType }) => {
          if (!user) {
            return { [AUTH_MODE_CLAIM]: 'workload',
              ...await installationClaim(config.pool, client.clientId, scopes, grantType) };
          }
          const security = await currentAccountGenerations(config.pool, user.id, client.clientId);
          if (!security && grantType) throw new APIError('BAD_REQUEST', {
            error: 'invalid_grant', error_description: 'account authorization is unavailable',
          });
          const securityClaims = { [ACCOUNT_GENERATION_CLAIM]: security?.account ?? '0',
            [GRANT_GENERATION_CLAIM]: security?.grant ?? '0' };
          // The provider rewrites pairwise sub only when presenting the
          // introspection response. This profile needs sub to be the durable
          // Account user ID so it can bind the current consent row.
          if (!client.skipConsent && client.subjectType === 'pairwise') {
            if (grantType) throw new APIError('BAD_REQUEST', {
              error: 'invalid_client', error_description: 'pairwise consent requires a subject binding',
            });
            return {};
          }
          if (grantType === 'authorization_code') {
            const code = (ctx.body as { code?: unknown } | undefined)?.code;
            if (typeof code !== 'string' || !code) throw new APIError('BAD_REQUEST', {
              error: 'invalid_grant', error_description: 'authorization code basis unavailable',
            });
            let basis;
            try {
              basis = await currentAuthorizationCodeBasis(config.pool, {
                code, clientId: client.clientId, userId: user.id,
                referenceId, scopes, resources,
              });
            } catch {
              throw new APIError('SERVICE_UNAVAILABLE', {
                error: 'temporarily_unavailable', error_description: 'authorization code basis unavailable',
              });
            }
            if (!basis || (basis.mode === 'trusted') !== !!client.skipConsent) {
              throw new APIError('BAD_REQUEST', {
                error: 'invalid_grant', error_description: 'authorization code basis is stale',
              });
            }
            const version = await config.pool.query<{ account: string; grant: string }>(`SELECT
              account_generation::text AS account, grant_generation::text AS grant
              FROM rezics_oauth_code_basis WHERE id = $1`,
            [createHash('sha256').update(code).digest('base64url')]);
            if (!security || version.rows[0]?.account !== security.account || version.rows[0]?.grant !== security.grant) {
              throw new APIError('BAD_REQUEST', { error: 'invalid_grant', error_description: 'account authorization is stale' });
            }
            const installation = { [INSTALLATION_CLAIM]: basis.installationId };
            const recovery = { [RECOVERY_GENERATION_CLAIM]: basis.recoveryGeneration };
            return basis.mode === 'trusted' ? { [AUTH_MODE_CLAIM]: 'trusted',
              ...installation, ...recovery, ...securityClaims }
              : { [AUTH_MODE_CLAIM]: 'consent', [CONSENT_CLAIM]: basis.consentId,
                [CONSENT_GENERATION_CLAIM]: basis.generation, ...installation, ...recovery, ...securityClaims };
          }
          // A refresh binds the current installation; the refresh-token write
          // in the same exchange fails unless it is still the family's own.
          const installation = await installationClaim(config.pool, client.clientId, scopes, grantType);
          const recovery = { [RECOVERY_GENERATION_CLAIM]:
            await currentRecoveryGeneration(config.pool, user.id) };
          if (client.skipConsent) return { [AUTH_MODE_CLAIM]: 'trusted',
            ...installation, ...recovery, ...securityClaims };
          const consent = await config.pool.query<{ id: string; generation: string }>(
            `SELECT id, "rezicsGeneration"::text AS generation FROM "oauthConsent"
            WHERE "userId" = $1 AND "clientId" = $2
              AND "referenceId" IS NOT DISTINCT FROM $3
              AND scopes @> to_jsonb($4::text[])
              AND (cardinality($5::text[]) = 0 OR resources @> to_jsonb($5::text[]))
            LIMIT 1`, [user.id, client.clientId, referenceId ?? null,
            scopes, resources ?? []]);
          if (!consent.rows[0]) {
            if (grantType) throw new APIError('BAD_REQUEST', {
              error: 'invalid_grant', error_description: 'current consent is unavailable',
            });
            return {};
          }
          return { [AUTH_MODE_CLAIM]: 'consent', [CONSENT_CLAIM]: consent.rows[0].id,
            [CONSENT_GENERATION_CLAIM]: consent.rows[0].generation,
            ...installation, ...recovery, ...securityClaims };
        } } }],
      }),
    ],
  };
}

/** The local profile is an explicit offline development verifier, never a
 * fallback from a failed provider. OAuth and session endpoints are unaffected. */
function enrollmentChallenge(config: AccountConfig) {
  const hostname = new URL(config.baseURL).hostname;
  const plugin = captcha({ provider: 'cloudflare-turnstile', secretKey: config.turnstileSecretKey ?? '',
    siteVerifyURLOverride: config.turnstileVerifyURL, endpoints: enrollmentEndpoints,
    expectedAction: 'account-enrollment', allowedHostnames: [hostname] });
  return { ...plugin, onRequest: async (request: Request, ctx: Parameters<typeof plugin.onRequest>[1]) => {
    const pathname = new URL(request.url).pathname;
    const basePath = ctx.options.basePath ?? '/api/auth';
    const path = (pathname.startsWith(basePath) ? pathname.slice(basePath.length) : pathname)
      .replace(/\/{2,}/g, '/').replace(/\/$/, '');
    if (!enrollmentEndpoints.includes(path)) return;
    // Local mode explicitly passes without a provider. Embedded protocol
    // fixtures may omit CAPTCHA configuration; production requires it.
    if (config.turnstileMode === 'local' || (!config.turnstileMode && !config.turnstileSecretKey)) return;
    // This ceiling bounds failed CAPTCHA attempts and provider work by caller,
    // never by the victim's email. The HTTP boundary replaces this address.
    const address = request.headers.get('x-rezics-client-ip') ?? 'unknown';
    try {
      if (!await consumeAccountLimit(config.pool, config.secret, `enrollment-caller:${address}`, 20, 300)) {
        return { response: Response.json({ error: 'rate_limited' }, { status: 429,
          headers: { 'retry-after': '300' } }) };
      }
    } catch { return { response: Response.json({ error: 'temporarily_unavailable' }, { status: 503 }) }; }
    return plugin.onRequest(request, ctx);
  } };
}

/** Every issued access token names the App installation that admitted it. An
 * issuance without an active installation, or beyond its ceiling, is refused;
 * a claim re-derived without a grant (opaque introspection) carries none. */
async function installationClaim(pool: Pool, clientId: string, scopes: string[],
  grantType: string | undefined): Promise<Record<string, string>> {
  let installation;
  try { installation = await currentInstallationIn(pool, clientId, scopes); }
  catch {
    throw new APIError('SERVICE_UNAVAILABLE', {
      error: 'temporarily_unavailable', error_description: 'App installation unavailable',
    });
  }
  if (!installation?.covers) {
    if (!grantType) return {};
    throw new APIError('BAD_REQUEST', installation
      ? { error: 'invalid_scope', error_description: 'scope exceeds the App installation' }
      : { error: 'unauthorized_client', error_description: 'App installation is not active' });
  }
  return { [INSTALLATION_CLAIM]: installation.id };
}

export function createAccountAuth(config: AccountConfig) {
  return betterAuth(accountAuthOptions(config));
}
