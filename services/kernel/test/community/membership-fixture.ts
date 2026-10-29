import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { Pool } from 'pg';
import { createAccess } from '../../src/access/index.ts';
import type { Access, AccessConfig, AccountActor } from '../../src/request/access.ts';
import { productionActions } from '../support/production-actions.ts';

const issuer = 'https://membership.auth.test';
const audience = 'https://membership.api.test';

export type ProductionAccess = {
  /** The kernel's production composition: authenticator, command admission and durable identity bridge. */
  access: Access;
  /** Sign an Access token the way Auth does. Only Access's authenticator turns it into an actor. */
  mint(accountId: string, scopes: readonly string[], clientId?: string): Promise<string>;
  /** The actor object the authenticator produced for a minted token. */
  authenticate(pool: Pool, accountId: string, scopes: readonly string[], clientId?: string): Promise<AccountActor>;
};

/** Build Access exactly as production does, over a locally generated key set. */
export async function createProductionAccess(
  config: Omit<AccessConfig, 'actions'> & {
    actions: readonly string[];
  },
): Promise<ProductionAccess> {
  const pair = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'membership', alg: 'ES256', use: 'sig' };
  const catalogue = productionActions();
  const access = createAccess({
    ...config,
    actions: new Map(config.actions.map((action) => [action, catalogue.get(action) ?? { anonymous: false }])),
    auth: {
      issuer,
      audience,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: async () => Response.json({ keys: [jwk] }),
    },
  });
  async function mint(accountId: string, scopes: readonly string[], clientId = 'realm-membership') {
    const iat = Math.floor(Date.now() / 1000) - 2;
    return new SignJWT({
      sub: accountId,
      client_id: clientId,
      scope: scopes.join(' '),
      authn_epoch: 1,
      iat,
      exp: iat + 300,
      auth_time: iat,
      amr: ['pwd'],
    })
      .setIssuer(issuer)
      .setAudience(audience)
      .setProtectedHeader({ alg: 'ES256', kid: 'membership', typ: 'at+jwt' })
      .sign(pair.privateKey);
  }
  return {
    access,
    mint,
    async authenticate(pool, accountId, scopes, clientId) {
      return access.authenticate(await mint(accountId, scopes, clientId), { pool, deadline: Date.now() + 30_000 });
    },
  };
}

export type ConsentAnswer = (input: { actorAccountId: string; clientId: string }) => Promise<readonly string[] | null>;
export type ConsentServer = {
  /** The consent URL the kernel worker reads, plus the service token it presents. */
  env: Record<string, string>;
  close(): Promise<void>;
};

/** Auth's current-consent read endpoint, served from this process over HTTPS with a generated
 * certificate. The worker trusts that certificate through NODE_EXTRA_CA_CERTS, so its real
 * `createAuthConsentReader` runs unchanged; the answer callback decides each restoration.
 */
export async function startConsentServer(answer: ConsentAnswer): Promise<ConsentServer> {
  const directory = mkdtempSync(join(tmpdir(), 'membership-consent-'));
  const key = join(directory, 'key.pem');
  const certificate = join(directory, 'certificate.pem');
  const generated = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-keyout',
      key,
      '-out',
      certificate,
    ],
    { encoding: 'utf8' },
  );
  if (generated.status !== 0) {
    rmSync(directory, { recursive: true, force: true });
    throw new Error(`Could not generate the consent test certificate: ${generated.stderr}`);
  }
  const tokenId = 'membership-consent.access';
  const tokenSecret = 'membership-consent-access-secret';
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    tls: { cert: Bun.file(certificate), key: Bun.file(key) },
    async fetch(request) {
      const url = new URL(request.url);
      if (
        request.method !== 'POST' ||
        url.pathname !== '/internal/v1/consents:read' ||
        request.headers.get('CF-Access-Client-Id') !== tokenId ||
        request.headers.get('CF-Access-Client-Secret') !== tokenSecret
      )
        return Response.json({ error: 'denied' }, { status: 403 });
      const input = (await request.json()) as { actorAccountId: string; clientId: string };
      const scopes = await answer(input);
      if (scopes === null) return Response.json({ error: 'denied' }, { status: 403 });
      return Response.json({ actorAccountId: input.actorAccountId, clientId: input.clientId, scopes: [...scopes] });
    },
  });
  return {
    env: {
      KERNEL_AUTH_CONSENT_URL: `https://localhost:${server.port}/internal/v1/consents:read`,
      CF_ACCESS_CLIENT_ID: tokenId,
      CF_ACCESS_CLIENT_SECRET: tokenSecret,
      NODE_EXTRA_CA_CERTS: certificate,
    },
    async close() {
      await server.stop(true);
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
