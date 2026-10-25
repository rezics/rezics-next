import type { BetterAuthOptions } from 'better-auth';
import type { Pool } from 'pg';

/** Shared with the official Better Auth migration generator. */
export function betterAuthOptions(database: Pool, issuer: string, secret: string) {
  return {
    database,
    baseURL: issuer,
    basePath: '/api/auth',
    secret,
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
