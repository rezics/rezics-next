import { betterAuth } from 'better-auth';
import { jwt } from 'better-auth/plugins';
import { oauthProvider } from '@better-auth/oauth-provider';
import type { Pool } from 'pg';
import { betterAuthOptions, credentialOwnerSchema } from '../src/better-auth.ts';

/** Shared by both diagnostic processes; never mounted by the Auth service. */
export function nativeProbeOptions(
  database: Pool,
  issuer: string,
  secret: string,
  audience: string,
  scopes: string[],
  onIssuance: () => void,
) {
  return {
    ...betterAuthOptions(database, issuer, secret),
    logger: { disabled: true },
    plugins: [
      credentialOwnerSchema,
      jwt({ jwt: { issuer }, jwks: { keyPairConfig: { alg: 'ES256' as const } } }),
      oauthProvider({
        loginPage: '/signin',
        consentPage: '/consent',
        scopes,
        resources: [{ identifier: audience, scopes: ['media:read'] }],
        grantTypes: ['authorization_code', 'refresh_token'],
        assertionMaxLifetime: 120,
        accessTokenExpiresIn: 300,
        refreshTokenReuseInterval: 0,
        clientPrivileges: () => true,
        resourcePrivileges: () => true,
        customAccessTokenClaims: () => {
          onIssuance();
          return {};
        },
        customTokenResponseFields: () => {
          onIssuance();
          return {};
        },
      }),
    ],
  };
}

if (import.meta.main) {
  // Connection credentials travel over a private parent/child pipe. Only the
  // ephemeral listener port is written to stdout, never configuration or tokens.
  const configuration: {
    url: string;
    issuer: string;
    secret: string;
    audience: string;
    scopes: string[];
  } = JSON.parse(await Bun.stdin.text());
  const { Pool: PostgresPool } = await import('pg');
  const database = new PostgresPool({ connectionString: configuration.url, max: 1 });
  let issuanceHooks = 0;
  const native = betterAuth(
    nativeProbeOptions(
      database,
      configuration.issuer,
      configuration.secret,
      configuration.audience,
      configuration.scopes,
      () => issuanceHooks++,
    ),
  );
  await native.$context;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === '/probe/hooks') return Response.json({ issuanceHooks });
      return native.handler(request);
    },
  });
  console.log(JSON.stringify({ port: server.port }));
  process.once('SIGTERM', async () => {
    await server.stop(true);
    await database.end();
    process.exit(0);
  });
}
