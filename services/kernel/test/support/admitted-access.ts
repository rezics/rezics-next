import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { Pool } from 'pg';
import { EMPTY_ACCESS_WORK } from '../../src/access/work.ts';
import { createAccess, createResourcePublicEligibility, type AccessConfig } from '../../src/access/index.ts';
import { statementBytes } from '../../src/database/statement-bytes.ts';
import { collectionDirectoryRowPlan } from '../../src/library/collection-directory-bounds.ts';
import collectionRead from '../../src/library/collection-reads-collection.sql';
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
  const identity = Object.freeze({ route: resource.route, id: resource.id });
  const declared = collectionDirectoryRowPlan(identity).total;
  const native = Object.freeze({
    keys: declared.candidateKeys,
    points: declared.nativePoints,
    rows: declared.nativeRows,
    witnesses: declared.witnessKeys,
    emptySeeks: declared.emptySeeks,
    bytes: declared.bytes - statementBytes(collectionRead),
  });
  return createResourcePublicEligibility({
    work: {
      prepare: { bound: () => EMPTY_ACCESS_WORK, actual: () => EMPTY_ACCESS_WORK },
      verify: { bound: () => native, actual: () => native },
    },
    resource: identity,
    action: 'collection:read',
    async prepare() {
      return { ready: true as const };
    },
    async verify({ client }) {
      const row = await collectionDirectoryRowPlan(identity).run({ query: client.query.bind(client) });
      return row != null && row.state === 'active' && row.visibility !== 'private';
    },
  });
}

/**
 * Repeatable-read snapshot matching GET members `loadCollection` / FULL members:
 * authorize on that client without a second minted T that prepare did not capture.
 */
export async function authorizeMintedRead(
  check: AccessCheck,
  pool: Pool,
  deadline = Date.now() + 5000,
): Promise<boolean> {
  return withReadTransaction(pool, (client) => check(client), deadline);
}
