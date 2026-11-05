import { decodeProtectedHeader, importJWK, jwtVerify } from 'jose';
import type { JWK, JWTPayload } from 'jose';
import type { Pool } from 'pg';

export class InvalidKeyAssertion extends Error {
  constructor() {
    super('Invalid credential');
  }
}

/** The credential registry accepts only public ES256 verification material. */
export async function publicCredential(jwk: JWK, kid: string): Promise<JWK> {
  if (
    !jwk ||
    Object.keys(jwk).some((key) => !['kty', 'crv', 'x', 'y', 'kid', 'alg', 'use', 'key_ops', 'ext'].includes(key)) ||
    jwk.kty !== 'EC' ||
    jwk.crv !== 'P-256' ||
    (jwk.alg !== undefined && jwk.alg !== 'ES256') ||
    (jwk.kid !== undefined && jwk.kid !== kid) ||
    (jwk.use !== undefined && jwk.use !== 'sig') ||
    (jwk.key_ops !== undefined && (jwk.key_ops.length !== 1 || jwk.key_ops[0] !== 'verify'))
  )
    throw new Error('Invalid credential');
  const publicJwk: JWK = { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y!, kid, alg: 'ES256', use: 'sig' };
  await importJWK(publicJwk, 'ES256');
  return publicJwk;
}

export async function verifyKeyAssertion(
  database: Pool,
  accountId: string,
  assertion: string,
  audience: string,
): Promise<void> {
  let header;
  try {
    header = decodeProtectedHeader(assertion);
  } catch {
    throw new InvalidKeyAssertion();
  }
  if (header.alg !== 'ES256' || typeof header.kid !== 'string') throw new InvalidKeyAssertion();
  const result = await database.query<{ public_jwk: JWK }>(
    'SELECT public_jwk FROM auth_public_key WHERE account_id=$1 AND kid=$2',
    [accountId, header.kid],
  );
  const registered = result.rows[0];
  if (!registered) throw new InvalidKeyAssertion();
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(assertion, await importJWK(registered.public_jwk, 'ES256'), {
      algorithms: ['ES256'],
      issuer: accountId,
      subject: accountId,
      audience,
      requiredClaims: ['iss', 'sub', 'aud', 'iat', 'exp', 'jti'],
      maxTokenAge: 60,
    }));
  } catch {
    throw new InvalidKeyAssertion();
  }
  const now = Math.floor(Date.now() / 1000);
  if (
    payload.aud !== audience ||
    !Number.isSafeInteger(payload.iat) ||
    !Number.isSafeInteger(payload.exp) ||
    payload.iat! > now ||
    payload.exp! <= payload.iat! ||
    payload.exp! - payload.iat! > 60 ||
    typeof payload.jti !== 'string' ||
    !payload.jti ||
    payload.jti.length > 128
  )
    throw new InvalidKeyAssertion();
  // Uniqueness is account-wide, survives restarts/key replacement, and arbitrates concurrent replay.
  try {
    await database.query('INSERT INTO auth_key_assertion (account_id, jti, expires_at) VALUES ($1,$2,$3)', [
      accountId,
      payload.jti,
      new Date(payload.exp! * 1000),
    ]);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === '23505')
      throw new InvalidKeyAssertion();
    throw error;
  }
}
