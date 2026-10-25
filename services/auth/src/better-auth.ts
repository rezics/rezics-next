import type { BetterAuthOptions, BetterAuthPlugin } from 'better-auth';
import type { Pool } from 'pg';
import { jwt } from 'better-auth/plugins';
import { websiteProvider } from './website-provider.ts';
import { nativeAttemptOptions } from './rate-limit.ts';
import { nativeSessionLimits } from './session-limits.ts';
import { nativeVerificationPlugin } from './verification-maintenance.ts';

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
  return {
    ...nativeAttemptOptions(database, issuer, secret),
    database,
    baseURL: issuer,
    basePath: '/api/auth',
    secret,
    plugins: [credentialOwnerSchema, nativeVerificationPlugin, nativeSessionLimits(database), jwt(), websiteProvider(issuer, 'https://api.rezics.com', ['openid', 'offline_access'])],
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
