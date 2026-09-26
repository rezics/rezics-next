import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { jwt } from 'better-auth/plugins';
import { oauthProvider } from '@better-auth/oauth-provider';
import { Pool } from 'pg';
import { AUTH_MODE_CLAIM, CONSENT_CLAIM, CONSENT_GENERATION_CLAIM,
  currentAuthorizationCodeBasis } from './consent-fence.ts';
import { currentInstallationIn, INSTALLATION_CLAIM } from './installations.ts';
import { signingKeyOptions } from './signing-keys.ts';

export interface AccountConfig {
  baseURL: string;
  secret: string;
  resource: string;
  pool: Pool;
  operatorUserIds: ReadonlySet<string>;
  accessDeletionFence?: (accountSubject: string) => Promise<void>;
}

export function accountAuthOptions(config: AccountConfig) {
  if (config.secret.length < 32) throw new Error('ACCOUNT_SECRET must contain at least 32 characters');
  const resource = new URL(config.resource);
  if (resource.hash || !['http:', 'https:'].includes(resource.protocol)) {
    throw new Error('ACCOUNT_RESOURCE must be an absolute HTTP(S) URL without a fragment');
  }
  return {
    baseURL: config.baseURL,
    secret: config.secret,
    database: config.pool,
    emailAndPassword: { enabled: true },
    user: { deleteUser: { enabled: !!config.accessDeletionFence,
      beforeDelete: async (user: { id: string }) => {
        if (config.operatorUserIds.has(user.id)) {
          throw new APIError('CONFLICT', { message: 'transfer operator responsibility before deletion' });
        }
        const ownedClient = await config.pool.query(
          'SELECT 1 FROM "oauthClient" WHERE "userId" = $1 LIMIT 1', [user.id]);
        if (ownedClient.rowCount) {
          throw new APIError('CONFLICT', { message: 'transfer OAuth clients before deletion' });
        }
        try { await config.accessDeletionFence!(user.id); }
        catch { throw new APIError('SERVICE_UNAVAILABLE',
          { message: 'Account deletion awaits the Access fence and retained deletion journal' }); }
      },
    } },
    plugins: [
      jwt(signingKeyOptions(config.pool)),
      oauthProvider({
        loginPage: '/sign-in',
        consentPage: '/consent',
        scopes: ['openid', 'profile', 'email', 'offline_access', 'work:create', 'work:edit', 'work:read', 'comment:create', 'space:create', 'realm:adopt', 'realm:reject', 'realm:classify', 'classification:define', 'classification:decide', 'rating:configure', 'rating:submit', 'rating:read', 'address:claim', 'address:manage', 'access:manage', 'access:membership-consent', 'access:approve', 'access:grant', 'access:represent', 'access:representation-manage', 'access:role', 'source:intake', 'source:acquire', 'source:convert', 'source:propose', 'source:correspond', 'source:adopt', 'source:read', 'package:capture', 'package:resolve', 'package:verify', 'package:read'],
        resources: [{ identifier: config.resource,
          allowedScopes: ['openid', 'offline_access', 'work:create', 'work:edit', 'work:read', 'comment:create', 'space:create', 'realm:adopt', 'realm:reject', 'realm:classify', 'classification:define', 'classification:decide', 'rating:configure', 'rating:submit', 'rating:read', 'address:claim', 'address:manage', 'access:manage', 'access:membership-consent', 'access:approve', 'access:grant', 'access:represent', 'access:representation-manage', 'access:role', 'source:intake', 'source:acquire', 'source:convert', 'source:propose', 'source:correspond', 'source:adopt', 'source:read', 'package:capture', 'package:resolve', 'package:verify', 'package:read'], accessTokenTtl: 300 }],
        clientRegistrationDefaultResources: [config.resource],
        allowDynamicClientRegistration: false,
        storeTokens: 'hashed',
        accessTokenExpiresIn: 300,
        clientPrivileges: ({ user }) => !!user && config.operatorUserIds.has(user.id),
        resourcePrivileges: ({ user }) => !!user && config.operatorUserIds.has(user.id),
        extensions: [{ claims: { accessToken: async ({ ctx, user, client, scopes, resources,
          referenceId, grantType }) => {
          if (!user) {
            return { [AUTH_MODE_CLAIM]: 'workload',
              ...await installationClaim(config.pool, client.clientId, scopes, grantType) };
          }
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
            const installation = { [INSTALLATION_CLAIM]: basis.installationId };
            return basis.mode === 'trusted' ? { [AUTH_MODE_CLAIM]: 'trusted', ...installation }
              : { [AUTH_MODE_CLAIM]: 'consent', [CONSENT_CLAIM]: basis.consentId,
                [CONSENT_GENERATION_CLAIM]: basis.generation, ...installation };
          }
          // A refresh binds the current installation; the refresh-token write
          // in the same exchange fails unless it is still the family's own.
          const installation = await installationClaim(config.pool, client.clientId, scopes, grantType);
          if (client.skipConsent) return { [AUTH_MODE_CLAIM]: 'trusted', ...installation };
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
            [CONSENT_GENERATION_CLAIM]: consent.rows[0].generation, ...installation };
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
