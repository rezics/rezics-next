import type { BetterAuthOptions, BetterAuthPlugin } from 'better-auth';
import type { Pool } from 'pg';

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
    database,
    baseURL: issuer,
    basePath: '/api/auth',
    secret,
    plugins: [credentialOwnerSchema],
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
