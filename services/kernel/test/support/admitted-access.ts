import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { Pool } from 'pg';
import { createAccess, createResourcePublicEligibility, type AccessConfig } from '../../src/access/index.ts';
import { mintReadTime, releaseOperationalTime } from '../../src/command/command.ts';
import type { Access, AccessCheck, AccessContext, AccountActor, Resource } from '../../src/request/access.ts';
import { withReadTransaction } from '../../src/semantic/read.ts';

const issuer = 'https://admitted-access.example.test';
const audience = 'https://api.admitted-access.example.test';
let signingKeys: Awaited<ReturnType<typeof generateKeyPair>> | undefined;
let jwks: object | undefined;

async function signing(): Promise<CryptoKeyPair> {
  signingKeys ??= await generateKeyPair('ES256');
  jwks ??= { keys: [{ ...(await exportJWK(signingKeys.publicKey)), kid: 'fixture', alg: 'ES256' }] };
  return signingKeys;
}

/** An Access from `createAccess`, so command admission and the other registries are installed. */
export function admittedAccess(config: Omit<AccessConfig, 'auth'>): Access {
  return createAccess({
    ...config,
    auth: {
      issuer,
      audience,
      jwksUrl: `${issuer}/jwks`,
      async fetch() {
        await signing();
        return Response.json(jwks);
      },
    },
  });
}

/** Sign an access token this factory's Access will accept once the account exists. */
export async function accountToken(account: {
  accountId: string;
  clientId: string;
  scopes: readonly string[];
  authnEpoch?: number;
  requestedBy?: string | null;
}): Promise<string> {
  const keys = await signing();
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: issuer,
    aud: audience,
    sub: account.accountId,
    client_id: account.clientId,
    scope: account.scopes.join(' '),
    authn_epoch: account.authnEpoch ?? 1,
    iat: now,
    exp: now + 300,
    auth_time: now,
    amr: ['pwd'],
    ...(account.requestedBy ? { requested_by: account.requestedBy } : {}),
  })
    .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: 'fixture' })
    .sign(keys.privateKey);
}

/** The returned actor is the only object this Access will admit for these claims. */
export async function authenticateAccount(
  access: Access,
  context: AccessContext,
  account: {
    accountId: string;
    clientId: string;
    scopes: readonly string[];
    authnEpoch?: number;
    requestedBy?: string | null;
  },
): Promise<AccountActor> {
  return access.authenticate(await accountToken(account), context);
}

/** Current GET members floor: private collections are not public; owner grants remain the read path. */
export function collectionReadEligibility(resource: Pick<Resource, 'route' | 'id'>) {
  return createResourcePublicEligibility({
    resource,
    action: 'collection:read',
    async prepare() {
      return { ready: true as const };
    },
    async verify({ client }) {
      const result = await client.query<{ visibility: string; state: string }>(
        `SELECT visibility, state FROM library.collection WHERE route=$1 AND collection_id=$2`,
        [resource.route, resource.id],
      );
      const row = result.rows[0];
      return row !== undefined && row.state === 'active' && row.visibility !== 'private';
    },
  });
}

/** Repeatable-read snapshot plus minted T, matching the production collection read. */
export async function authorizeMintedRead(
  check: AccessCheck,
  pool: Pool,
  deadline = Date.now() + 5000,
  clock?: () => Date,
): Promise<boolean> {
  return withReadTransaction(
    pool,
    async (client) => {
      const time = await mintReadTime(client, clock);
      try {
        return await check(client, time);
      } finally {
        releaseOperationalTime(time);
      }
    },
    deadline,
  );
}
