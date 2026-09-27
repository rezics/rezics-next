import { betterAuth } from 'better-auth';
import { createHash } from 'node:crypto';
import { APIError } from 'better-auth/api';
import { jwt, openAPI, twoFactor } from 'better-auth/plugins';
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
import { afterPasskeyAssertion, emailLocale, localeField, markEmailChangeStep } from './account-settings.ts';
import { deviceLabel } from './security-activity.ts';
import { ACCOUNT_GENERATION_CLAIM, GRANT_GENERATION_CLAIM, currentAccountGenerations } from './account-fence.ts';
import { bootstrapOperators, operatorRole, rolePermits } from './operators.ts';
import { operatorAuthHooks } from './operator-auth-hooks.ts';

export interface AccountConfig {
  baseURL: string;
  secret: string;
  resource: string;
  pool: Pool;
  operatorUserIds: ReadonlySet<string>;
  email?: AccountEmail;
  /** The HTTP process requires verification. Embedded protocol fixtures without a sender can omit it. */
  requireEmailVerification?: boolean;
  accessDeletionFence?: (accountSubject: string) => Promise<void>;
}

type EmailUser = { id: string; email: string; locale?: unknown };

export function accountAuthOptions(config: AccountConfig) {
  const requireEmailVerification = config.requireEmailVerification ?? !!config.email;
  if (config.secret.length < 32) throw new Error('ACCOUNT_SECRET must contain at least 32 characters');
  const resource = new URL(config.resource);
  if (resource.hash || !['http:', 'https:'].includes(resource.protocol)) {
    throw new Error('ACCOUNT_RESOURCE must be an absolute HTTP(S) URL without a fragment');
  }
  return {
    baseURL: config.baseURL,
    secret: config.secret,
    database: config.pool,
    advanced: { ipAddress: { ipAddressHeaders: ['x-rezics-client-ip'] } },
    // The HTTP boundary checks our session-bound reauthentication proof. The
    // provider's age-only check cannot recognize that proof after step-up.
    session: { freshAge: 0 },
    hooks: operatorAuthHooks(config.pool, config.operatorUserIds),
    databaseHooks: { session: { create: { before: async (session: { userId: string }) => {
      const blocked = await config.pool.query(`SELECT 1 FROM rezics_account_security WHERE user_id = $1
        AND (deletion_started_at IS NOT NULL OR password_reset_required OR (suspended_at IS NOT NULL AND (suspended_until IS NULL OR suspended_until > now())))`, [session.userId]);
      if (blocked.rowCount) {
        throw new APIError('FORBIDDEN', { code: 'ACCOUNT_UNAVAILABLE', message: 'Sign-in is unavailable for this account' });
      }
      return { data: session };
    } } } },
    emailAndPassword: { enabled: true,
      requireEmailVerification,
      minPasswordLength: 12,
      resetPasswordTokenExpiresIn: 1800,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }: { user: EmailUser; url: string }, request?: Request) => {
        if (!config.email) throw new Error('Account email delivery is not configured');
        await config.email.enqueue({ userId: user.id, to: user.email, url,
          purpose: 'reset', locale: emailLocale(user, request) })
          .catch(() => console.error('Account email intent unavailable'));
      },
    },
    emailVerification: { sendOnSignUp: true, expiresIn: 1800,
      sendVerificationEmail: async ({ user, url }: { user: EmailUser; url: string }, request?: Request) => {
        if (!config.email && !requireEmailVerification) return;
        if (!config.email) throw new Error('Account email delivery is not configured');
        await config.email.enqueue({ userId: user.id, to: user.email, url: markEmailChangeStep(url, 'verified'),
          purpose: 'verify', locale: emailLocale(user, request) })
          .catch(() => console.error('Account email intent unavailable'));
      },
    },
    user: { additionalFields: { locale: localeField }, changeEmail: { enabled: true,
      sendChangeEmailConfirmation: async ({ user, url }: { user: EmailUser; url: string }, request?: Request) => {
        if (!config.email) throw new Error('Account email delivery is not configured');
        await config.email.enqueue({ userId: user.id, to: user.email, url: markEmailChangeStep(url, 'requested'),
          purpose: 'change-email', locale: emailLocale(user, request) });
      },
    }, deleteUser: { enabled: !!config.accessDeletionFence,
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
      openAPI({ disableDefaultReference: true }),
      twoFactor({ issuer: 'REZICS', allowPasswordless: true,
        backupCodeOptions: { storeBackupCodes: 'encrypted' } }),
      passkey({ rpName: 'REZICS', rpID: new URL(config.baseURL).hostname,
        origin: new URL(config.baseURL).origin,
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
          return { name: getAuthenticatorName(verification.registrationInfo.aaguid)
            ?? deviceLabel(ctx.headers?.get('user-agent')).label };
        } },
        authentication: { afterVerification: async ({ verification, clientData }) => {
          if (!verification.authenticationInfo.userVerified) {
            throw new APIError('FORBIDDEN', { code: 'USER_VERIFICATION_REQUIRED', message: 'Verify on your device' });
          }
          await afterPasskeyAssertion(config.pool, clientData.id);
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
        allowDynamicClientRegistration: false,
        storeTokens: 'hashed',
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
