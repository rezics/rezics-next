import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { jwt } from 'better-auth/plugins';
import { oauthProvider } from '@better-auth/oauth-provider';
import { Pool } from 'pg';

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
      jwt(),
      oauthProvider({
        loginPage: '/sign-in',
        consentPage: '/consent',
        scopes: ['openid', 'profile', 'email', 'offline_access', 'work:create', 'work:edit', 'work:read', 'space:create', 'realm:adopt', 'realm:reject', 'realm:classify', 'classification:define'],
        resources: [{ identifier: config.resource,
          allowedScopes: ['openid', 'offline_access', 'work:create', 'work:edit', 'work:read', 'space:create', 'realm:adopt', 'realm:reject', 'realm:classify', 'classification:define'], accessTokenTtl: 300 }],
        clientRegistrationDefaultResources: [config.resource],
        allowDynamicClientRegistration: false,
        accessTokenExpiresIn: 300,
        clientPrivileges: ({ user }) => !!user && config.operatorUserIds.has(user.id),
        resourcePrivileges: ({ user }) => !!user && config.operatorUserIds.has(user.id),
      }),
    ],
  };
}

export function createAccountAuth(config: AccountConfig) {
  return betterAuth(accountAuthOptions(config));
}
