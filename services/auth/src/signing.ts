import { importJWK, jwtVerify, SignJWT, type JWK } from 'jose';
import type { Pool } from 'pg';
import type { AccessTokenClaims, AuthServiceOptions, PublicJwks } from './index.ts';

type PrivateSigningKey = JWK & { kty: 'EC'; crv: 'P-256'; x: string; y: string; d: string; kid: string };

function normalize(key: JWK): PrivateSigningKey {
  if (
    key.kty !== 'EC' ||
    key.crv !== 'P-256' ||
    !key.x ||
    !key.y ||
    !key.d ||
    !key.kid ||
    (key.alg !== undefined && key.alg !== 'ES256')
  ) {
    throw new Error('Signing injection requires identified private ES256/P-256 keys');
  }
  return { kty: 'EC', crv: 'P-256', x: key.x, y: key.y, d: key.d, kid: key.kid, alg: 'ES256', use: 'sig' };
}

function publicKey(key: PrivateSigningKey): PublicJwks['keys'][number] {
  return { kty: key.kty, crv: key.crv, x: key.x, y: key.y, kid: key.kid, alg: 'ES256', use: 'sig' };
}

export async function createSigner(database: Pool, configuration: AuthServiceOptions['signing']) {
  if (!configuration?.activeKid) throw new Error('An active signing key ID is required');
  const injected = configuration.privateKeys.map(normalize);
  if (new Set(injected.map((key) => key.kid)).size !== injected.length) throw new Error('Duplicate signing key IDs');
  // Validate both halves before persisting an injected key. No runtime-generated production key.
  for (const key of injected) {
    const privatePart = await importJWK(key, 'ES256');
    const publicPart = await importJWK(publicKey(key), 'ES256');
    const probe = await new SignJWT({}).setProtectedHeader({ alg: 'ES256' }).sign(privatePart);
    await jwtVerify(probe, publicPart, { algorithms: ['ES256'] });
    await database.query('INSERT INTO auth_signing_key (kid, private_jwk) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
      key.kid,
      key,
    ]);
    const existing = await database.query<{ private_jwk: JWK }>(
      'SELECT private_jwk FROM auth_signing_key WHERE kid=$1',
      [key.kid],
    );
    if (JSON.stringify(normalize(existing.rows[0]!.private_jwk)) !== JSON.stringify(key)) {
      throw new Error('Signing key IDs are immutable; rotate with a new kid');
    }
  }
  const rows = await database.query<{ kid: string; private_jwk: JWK }>(
    'SELECT kid, private_jwk FROM auth_signing_key ORDER BY kid',
  );
  const active = rows.rows.find((row) => row.kid === configuration.activeKid);
  if (!active) throw new Error('Active signing key is not configured in Auth');
  const key = await importJWK(normalize(active.private_jwk), 'ES256');
  const jwks: PublicJwks = { keys: rows.rows.map((row) => publicKey(normalize(row.private_jwk))) };
  // Ensure the imported material is a private key, not symmetric or public-only material.
  if (key instanceof Uint8Array) throw new Error('Expected asymmetric signing material');
  return {
    jwks,
    sign(claims: AccessTokenClaims): Promise<string> {
      return new SignJWT({ ...claims }).setProtectedHeader({ alg: 'ES256', kid: active.kid, typ: 'at+jwt' }).sign(key);
    },
  };
}
