import { importJWK, jwtVerify, SignJWT, type JWK } from 'jose';
import type { Pool, PoolClient } from 'pg';
import type { AccessTokenClaims, AuthServiceOptions, PublicJwks, SigningControl, SigningState } from './index.ts';

// Native access and ID tokens live 300 seconds. Reserve that maximum plus
// the ten-minute recent-session logout hint horizon,
// 30s verifier cache and 60s clock allowance. Issuance rechecks the generation
// on every call, so there is no stale process signing lease to add here.
const retentionSeconds = 300 + 600 + 30 + 60;
const importCacheMilliseconds = 30_000;
type PrivateSigningKey = JWK & { kty: 'EC'; crv: 'P-256'; x: string; y: string; d: string; kid: string };
type Snapshot = {
  generation: number;
  ready: boolean;
  current: PrivateSigningKey | null;
  next: PrivateSigningKey | null;
  retiring: PrivateSigningKey | null;
  retain_until: Date | null;
  can_prune: boolean;
};

/** Another controller won the CAS, or every required slot is still occupied. */
export class SigningRotationPending extends Error {
  readonly code = 'signing_rotation_pending';
  constructor() {
    super('Signing rotation pending; refresh generation or wait for retention');
  }
}

function normalize(key: JWK): PrivateSigningKey {
  if (
    key.kty !== 'EC' ||
    key.crv !== 'P-256' ||
    !key.x ||
    !key.y ||
    !key.d ||
    !key.kid ||
    key.kid.length > 256 ||
    (key.alg !== undefined && key.alg !== 'ES256')
  ) {
    throw new Error('Signing injection requires identified private ES256/P-256 keys');
  }
  return { kty: 'EC', crv: 'P-256', x: key.x, y: key.y, d: key.d, kid: key.kid, alg: 'ES256', use: 'sig' };
}
function publicKey(key: PrivateSigningKey): PublicJwks['keys'][number] {
  return { kty: key.kty, crv: key.crv, x: key.x, y: key.y, kid: key.kid, alg: 'ES256', use: 'sig' };
}
async function validate(input: JWK): Promise<PrivateSigningKey> {
  const key = normalize(input);
  const privatePart = await importJWK(key, 'ES256');
  const publicPart = await importJWK(publicKey(key), 'ES256');
  const probe = await new SignJWT({}).setProtectedHeader({ alg: 'ES256' }).sign(privatePart);
  await jwtVerify(probe, publicPart, { algorithms: ['ES256'] });
  return key;
}

// Exact singleton and kid lookups: archived history never participates. A single
// statement gives a consistent generation/slot snapshot even across rotation.
async function read(database: Pool | PoolClient): Promise<Snapshot> {
  const result = await database.query<Snapshot>(`
    SELECT g.generation, g.upgrade_after <= statement_timestamp() AS ready,
      slots.keys->'current' AS current, slots.keys->'next' AS next,
      slots.keys->'retiring' AS retiring, slots.retain_until,
      slots.retain_until <= statement_timestamp() AS can_prune
    FROM auth_signing_generation g
    LEFT JOIN LATERAL (
      SELECT jsonb_object_agg(slot, private_jwk) AS keys, max(retain_until) AS retain_until
      FROM auth_signing_key WHERE kid=ANY(ARRAY[g.current_kid,g.next_kid,g.retiring_kid])
    ) slots ON true
    WHERE g.singleton=true`);
  const snapshot = result.rows[0];
  if (!snapshot?.ready) throw new SigningRotationPending();
  return snapshot;
}
function state(snapshot: Snapshot): SigningState {
  return {
    generation: snapshot.generation,
    current: snapshot.current?.kid ?? null,
    next: snapshot.next?.kid ?? null,
    retiring: snapshot.retiring?.kid ?? null,
  };
}
function cas(snapshot: Snapshot, expected: number): void {
  if (!Number.isSafeInteger(expected) || snapshot.generation !== expected) throw new SigningRotationPending();
}
async function transaction<T>(
  database: Pool,
  operation: (client: PoolClient, snapshot: Snapshot) => Promise<T>,
): Promise<T> {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    // Acquire the lock before taking the slot snapshot. After waiting for a
    // concurrent controller, READ COMMITTED must see its committed key rows too.
    await client.query('SELECT singleton FROM auth_signing_generation WHERE singleton=true FOR UPDATE');
    const value = await operation(client, await read(client));
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
async function archived(client: PoolClient, key: PrivateSigningKey): Promise<boolean> {
  const result = await client.query<{ private_jwk: JWK }>(
    'SELECT private_jwk FROM auth_signing_key_archive WHERE kid=$1',
    [key.kid],
  );
  if (!result.rows[0]) return false;
  if (JSON.stringify(normalize(result.rows[0].private_jwk)) !== JSON.stringify(key))
    throw new Error('Signing key IDs are immutable; rotate with a new kid');
  return true;
}
async function install(client: PoolClient, key: PrivateSigningKey, slot: 'current' | 'next'): Promise<void> {
  await client.query('INSERT INTO auth_signing_key_archive (kid, private_jwk) VALUES ($1,$2) ON CONFLICT DO NOTHING', [
    key.kid,
    key,
  ]);
  await client.query('INSERT INTO auth_signing_key (kid,slot,private_jwk) VALUES ($1,$2,$3)', [key.kid, slot, key]);
}
async function stage(client: PoolClient, snapshot: Snapshot, key: PrivateSigningKey): Promise<void> {
  // Checking identity precedes occupancy errors; a retired kid is never reusable.
  const known = await archived(client, key);
  if (known || snapshot.next || !snapshot.current) throw new SigningRotationPending();
  await install(client, key, 'next');
  await client.query('UPDATE auth_signing_generation SET next_kid=$1,generation=generation+1 WHERE singleton=true', [
    key.kid,
  ]);
}
async function rotate(client: PoolClient, snapshot: Snapshot, kid: string): Promise<void> {
  if (snapshot.retiring || !snapshot.current || snapshot.next?.kid !== kid) throw new SigningRotationPending();
  await client.query(
    `UPDATE auth_signing_key SET slot='retiring',retain_until=statement_timestamp()+$2*interval '1 second' WHERE kid=$1`,
    [snapshot.current.kid, retentionSeconds],
  );
  await client.query("UPDATE auth_signing_key SET slot='current' WHERE kid=$1", [kid]);
  await client.query(
    `UPDATE auth_signing_generation SET retiring_kid=current_kid,current_kid=next_kid,next_kid=NULL,generation=generation+1 WHERE singleton=true`,
  );
}
async function prune(client: PoolClient, snapshot: Snapshot): Promise<void> {
  if (!snapshot.retiring || !snapshot.can_prune) throw new SigningRotationPending();
  // One physical deletion per operation; immutable identity remains in cold storage.
  await client.query(
    "DELETE FROM auth_signing_key WHERE kid=$1 AND slot='retiring' AND retain_until<=statement_timestamp()",
    [snapshot.retiring.kid],
  );
  await client.query(
    'UPDATE auth_signing_generation SET retiring_kid=NULL,generation=generation+1 WHERE singleton=true',
  );
}

export async function createSigner(database: Pool, configuration: AuthServiceOptions['signing']) {
  if (!configuration?.activeKid) throw new Error('An active signing key ID is required');
  if (configuration.privateKeys.length > 3) throw new SigningRotationPending();
  if (new Set(configuration.privateKeys.map((key) => key.kid)).size !== configuration.privateKeys.length)
    throw new Error('Duplicate signing key IDs');
  // Validate every supplied key before any durable change, including both halves.
  const injected = await Promise.all(configuration.privateKeys.map(validate));
  await transaction(database, async (client, initial) => {
    let snapshot = initial;
    const known = new Set<string>();
    for (const key of injected) if (await archived(client, key)) known.add(key.kid);
    if (!snapshot.current) {
      const supplied = injected.find((key) => key.kid === configuration.activeKid);
      const existing =
        supplied ??
        (
          await client.query<{ private_jwk: JWK }>('SELECT private_jwk FROM auth_signing_key_archive WHERE kid=$1', [
            configuration.activeKid,
          ])
        ).rows[0]?.private_jwk;
      if (!existing) throw new Error('Active signing key is not configured in Auth');
      // This also validates an exact legacy key adopted after the upgrade barrier.
      await install(client, await validate(existing), 'current');
      await client.query(
        'UPDATE auth_signing_generation SET current_kid=$1,generation=generation+1 WHERE singleton=true',
        [configuration.activeKid],
      );
      snapshot = await read(client);
    }
    for (const key of injected) {
      if (known.has(key.kid) || key.kid === snapshot.current?.kid) continue;
      await stage(client, snapshot, key);
      snapshot = await read(client);
    }
    if (configuration.activeKid === snapshot.next?.kid) await rotate(client, snapshot, configuration.activeKid);
    else if (configuration.activeKid !== snapshot.current?.kid) {
      // A stale restart may name an archived former current. It follows durable
      // metadata and cannot roll it back. Unknown active IDs still fail closed.
      const result = await client.query('SELECT kid FROM auth_signing_key_archive WHERE kid=$1', [
        configuration.activeKid,
      ]);
      if (!result.rowCount) throw new Error('Active signing key is not configured in Auth');
    }
  });

  const control: SigningControl = {
    async status() {
      return state(await read(database));
    },
    async stage(input) {
      const key = await validate(input.key);
      return transaction(database, async (client, snapshot) => {
        cas(snapshot, input.expectedGeneration);
        await stage(client, snapshot, key);
        return state(await read(client));
      });
    },
    async rotate(input) {
      return transaction(database, async (client, snapshot) => {
        cas(snapshot, input.expectedGeneration);
        await rotate(client, snapshot, input.kid);
        return state(await read(client));
      });
    },
    async prune(input) {
      return transaction(database, async (client, snapshot) => {
        cas(snapshot, input.expectedGeneration);
        await prune(client, snapshot);
        return state(await read(client));
      });
    },
  };
  let cache: { generation: number; expires: number; key: CryptoKey; jwks: PublicJwks } | undefined;
  async function refresh() {
    const snapshot = await read(database);
    if (!snapshot.current) throw new Error('No active signing key');
    if (cache?.generation === snapshot.generation && cache.expires > performance.now()) return cache;
    const keys = [snapshot.current, snapshot.next, snapshot.retiring]
      .filter((key): key is PrivateSigningKey => key !== null)
      .map(normalize);
    const key = await importJWK(keys[0]!, 'ES256');
    if (key instanceof Uint8Array) throw new Error('Expected asymmetric signing material');
    const result = {
      generation: snapshot.generation,
      expires: performance.now() + importCacheMilliseconds,
      key,
      jwks: { keys: keys.map(publicKey) },
    };
    cache = result;
    return result;
  }
  return {
    control,
    async signProtocol(payload: import('jose').JWTPayload, header?: { typ?: string; cty?: string }): Promise<string> {
      const now = Math.floor(Date.now() / 1000);
      if (
        !Number.isSafeInteger(payload.iat) ||
        !Number.isSafeInteger(payload.exp) ||
        payload.iat! > now ||
        payload.exp! > payload.iat! + 300 ||
        payload.exp! <= now
      )
        throw new Error('Invalid protocol signing lifetime');
      const current = await refresh();
      return new SignJWT(payload)
        .setProtectedHeader({ alg: 'ES256', kid: current.jwks.keys[0]!.kid, typ: header?.typ ?? 'JWT' })
        .sign(current.key);
    },
    async getJwks(): Promise<PublicJwks> {
      return structuredClone((await refresh()).jwks);
    },
    async sign(claims: AccessTokenClaims): Promise<string> {
      // A stale/delayed caller cannot extend a retiring key's retention obligation.
      const now = Math.floor(Date.now() / 1000);
      if (
        !Number.isSafeInteger(claims.iat) ||
        !Number.isSafeInteger(claims.exp) ||
        claims.iat > now ||
        claims.exp > claims.iat + 300 ||
        claims.exp <= now
      )
        throw new Error('Signing lifetime exceeds the native token contract');
      const current = await refresh();
      return new SignJWT({ ...claims })
        .setProtectedHeader({ alg: 'ES256', kid: current.jwks.keys[0]!.kid, typ: 'at+jwt' })
        .sign(current.key);
    },
  };
}
