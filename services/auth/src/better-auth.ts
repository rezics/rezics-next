import type { BetterAuthOptions, BetterAuthPlugin } from 'better-auth';
import type { Pool } from 'pg';
import { passkeyPlugin } from './passkeys.ts';
import { jwt } from 'better-auth/plugins';
import { websiteProvider } from './website-provider.ts';
import { nativeAttemptOptions } from './rate-limit.ts';
import { nativeSessionLimits } from './session-limits.ts';
import { nativeVerificationPlugin } from './verification-maintenance.ts';
import { authBetterAuthLogger } from './diagnostics.ts';
import { installNativeRoleProducer } from './erasure-coverage.ts';

export const credentialOwnerSchema = {
  id: 'credential-owner-schema',
  schema: {
    user: {
      fields: {
        email: { type: 'string', required: false, unique: true, sortable: true },
      },
    },
  },
} satisfies BetterAuthPlugin;

/** Shared with the official Better Auth migration generator. */
export function betterAuthOptions(database: Pool, issuer: string, secret: string) {
  installNativeRoleProducer(database);
  return {
    ...nativeAttemptOptions(database, issuer, secret),
    logger: authBetterAuthLogger,
    database,
    baseURL: issuer,
    basePath: '/api/auth',
    secret,
    plugins: [credentialOwnerSchema, nativeVerificationPlugin, nativeSessionLimits(database), passkeyPlugin(issuer)],
    // Native cleanup is an unbounded DELETE, even behind an indexed adapter.
    // Expiry validation remains native; retention uses the internal batch port.
    verification: { disableCleanup: true },
    emailAndPassword: { enabled: true, disableSignUp: true },
    session: {
      cookieCache: { enabled: false },
      additionalFields: {
        clientId: { type: 'string', required: true, input: false },
        grantedScope: { type: 'string', required: true, input: false },
        authnEpoch: { type: 'number', required: true, input: false },
        authTime: { type: 'number', required: true, input: false },
        authMethods: { type: 'string', required: true, input: false },
      },
    },
  } satisfies BetterAuthOptions;
}

/**
 * Adds the schema-owning protocol plugins that each service instance composes
 * with its own signer, scopes and hooks. Shared with migration generation and
 * the committed-schema check; never used to serve requests.
 */
export function betterAuthSchemaOptions(database: Pool, issuer: string, secret: string) {
  const options = betterAuthOptions(database, issuer, secret);
  return { ...options, plugins: [...options.plugins, jwt(), websiteProvider(['openid', 'offline_access'])] };
}
