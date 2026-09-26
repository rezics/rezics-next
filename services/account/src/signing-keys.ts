import { randomUUID } from 'node:crypto';
import type { GenericEndpointContext } from '@better-auth/core';
import { createJwk, type Jwk, type JwtOptions } from 'better-auth/plugins/jwt';
import type { Pool, PoolClient } from 'pg';

/** Main resource access tokens live at most this long (auth.ts). */
export const ACCESS_TOKEN_SECONDS = 300;
/** A signer that loaded the superseded key just before activation may finish
 * signing afterwards; its token's `iat` is at most this much later. */
export const SIGNING_ALLOWANCE_SECONDS = 5;
/** A superseded key verifies only the tokens it could have signed. */
export const RETIREMENT_SECONDS = ACCESS_TOKEN_SECONDS + SIGNING_ALLOWANCE_SECONDS;
/** Resource servers, including Main, cache JWKS for up to 300 seconds. */
export const PUBLICATION_SECONDS = 300;

export class SigningKeyNotFound extends Error {}
export class SigningKeyStateError extends Error {}

export interface SigningKeyGeneration {
  kid: string;
  generation: string;
  state: 'staged' | 'active' | 'retiring' | 'retired';
  stagedAt: string;
  activatedAt: string | null;
  supersededAt: string | null;
  verifyUntil: string | null;
  retiredAt: string | null;
  retiredReason: 'expired' | 'compromised' | 'withdrawn' | null;
}

type LiveKey = { id: string; publicKey: string; privateKey: string; alg: string | null;
  crv: string | null; state: 'staged' | 'active' | 'retiring'; shownAt: Date };
type GenerationRow = { id: string; generation: string; state: SigningKeyGeneration['state'];
  staged_at: Date; activated_at: Date | null; superseded_at: Date | null;
  verify_until: Date | null; retired_at: Date | null;
  retired_reason: SigningKeyGeneration['retiredReason'] };

const LOCK = "SELECT pg_advisory_xact_lock(hashtextextended('rezics_signing_key', 0))";
const GENERATION_COLUMNS = `id, generation::text, state, staged_at, activated_at,
  superseded_at, verify_until, retired_at, retired_reason`;

/** Better Auth JWT plugin options whose keyring is the generation table. The
 * plugin signs with the single live key without `expiresAt` and publishes the
 * others while `expiresAt + gracePeriod` is ahead; staged and retiring keys
 * are shown with an `expiresAt` one second in the past, so they are published
 * but never sign. Retired keys are never shown. */
export function signingKeyOptions(pool: Pool): JwtOptions {
  return { jwks: { gracePeriod: 60 }, adapter: {
    // One indexed read of the live generations (at most one staged, one active
    // and the retiring keys of the last five minutes) per signing or JWKS read.
    getJwks: async () => {
      const shown = new Date(Date.now() - 1000);
      const live = await pool.query<LiveKey>(`SELECT j.id, j."publicKey",
          CASE WHEN k.state = 'active' THEN j."privateKey" ELSE '' END AS "privateKey",
          j.alg, j.crv, k.state, COALESCE(k.activated_at, k.staged_at) AS "shownAt"
        FROM public.rezics_signing_key k JOIN public.jwks j ON j.id = k.id
        WHERE k.state <> 'retired' AND (k.state <> 'retiring' OR k.verify_until > now())
        ORDER BY k.generation`);
      return live.rows.map(key => ({ id: key.id, publicKey: key.publicKey,
        privateKey: key.privateKey, createdAt: key.shownAt,
        ...(key.alg ? { alg: key.alg as Jwk['alg'] } : {}),
        ...(key.crv ? { crv: key.crv as Jwk['crv'] } : {}),
        ...(key.state === 'active' ? {} : { expiresAt: shown }) }));
    },
    // The plugin mints only when no key is active, which is first issuance.
    // Replicas serialize here, so exactly one generation becomes active.
    createJwk: async data => withLock(pool, async client => {
      const active = await client.query<{ id: string; publicKey: string; privateKey: string;
        alg: Jwk['alg'] | null; crv: Jwk['crv'] | null; createdAt: Date }>(
        `SELECT j.id, j."publicKey", j."privateKey", j.alg, j.crv, k.activated_at AS "createdAt"
         FROM public.rezics_signing_key k JOIN public.jwks j ON j.id = k.id
         WHERE k.state = 'active'`);
      const current = active.rows[0];
      if (current) {
        return { id: current.id, publicKey: current.publicKey, privateKey: current.privateKey,
          createdAt: current.createdAt, ...(current.alg ? { alg: current.alg } : {}),
          ...(current.crv ? { crv: current.crv } : {}) };
      }
      const id = randomUUID();
      await insertKey(client, id, data);
      const created = await client.query<{ createdAt: Date }>(`INSERT INTO public.rezics_signing_key
          (id, generation, state, staged_at, activated_at)
        SELECT $1, COALESCE(max(generation), 0) + 1, 'active', now(), now()
        FROM public.rezics_signing_key RETURNING activated_at AS "createdAt"`, [id]);
      return { ...data, id, createdAt: created.rows[0]!.createdAt };
    }),
  } };
}

/** Publish a new key without signing with it. At most one key is staged;
 * repeating the command returns it. The plugin generates and encrypts the key
 * material with the Account secret, exactly as for its own keys; `context` is
 * the Account's `auth.$context`. */
export async function stageSigningKey(pool: Pool,
  context: object): Promise<SigningKeyGeneration> {
  let staged: GenerationRow | undefined;
  await createJwk({ context } as unknown as GenericEndpointContext, { adapter: {
    createJwk: async data => withLock(pool, async client => {
      const existing = await client.query<GenerationRow>(
        `SELECT ${GENERATION_COLUMNS} FROM public.rezics_signing_key WHERE state = 'staged'`);
      if (existing.rows[0]) {
        staged = existing.rows[0];
      } else {
        const id = randomUUID();
        await insertKey(client, id, data);
        staged = (await client.query<GenerationRow>(`INSERT INTO public.rezics_signing_key
            (id, generation, state, staged_at)
          SELECT $1, COALESCE(max(generation), 0) + 1, 'staged', now()
          FROM public.rezics_signing_key RETURNING ${GENERATION_COLUMNS}`, [id])).rows[0]!;
      }
      return { ...data, id: staged.id };
    }),
  } });
  return generation(staged!);
}

/** Start signing with the staged key once verifiers have had time to fetch it.
 * The previous key stops signing now, loses its private material, and still
 * verifies for one access-token lifetime plus the in-flight allowance. */
export async function activateStagedKey(pool: Pool,
  minimumPublishedSeconds = PUBLICATION_SECONDS): Promise<SigningKeyGeneration> {
  return withLock(pool, async client => {
    const staged = await client.query<{ id: string; ready: boolean }>(`SELECT id,
        staged_at <= now() - make_interval(secs => $1) AS ready
      FROM public.rezics_signing_key WHERE state = 'staged'`, [minimumPublishedSeconds]);
    if (!staged.rows[0]) throw new SigningKeyStateError('no staged signing key');
    if (!staged.rows[0].ready) throw new SigningKeyStateError('staged key is not yet published long enough');
    return promote(client, staged.rows[0].id, 'retiring');
  });
}

/** Take a key out of use now: an active or retiring key's tokens become inactive
 * at once and it is unpublished; a staged key is withdrawn. Retiring the active
 * key requires a staged successor, which starts signing immediately. */
export async function retireSigningKey(pool: Pool, kid: string): Promise<SigningKeyGeneration> {
  return withLock(pool, async client => {
    const current = await client.query<{ state: SigningKeyGeneration['state'] }>(
      'SELECT state FROM public.rezics_signing_key WHERE id = $1', [kid]);
    const state = current.rows[0]?.state;
    if (!state) throw new SigningKeyNotFound('signing key not found');
    if (state === 'active') {
      const successor = await client.query<{ id: string }>(
        "SELECT id FROM public.rezics_signing_key WHERE state = 'staged'");
      if (!successor.rows[0]) throw new SigningKeyStateError('stage a successor before retiring the active key');
      await promote(client, successor.rows[0].id, 'retired');
    } else if (state !== 'retired') {
      await client.query(`UPDATE public.rezics_signing_key SET state = 'retired',
          superseded_at = COALESCE(superseded_at, now()), retired_at = now(),
          retired_reason = CASE WHEN activated_at IS NULL THEN 'withdrawn' ELSE 'compromised' END
        WHERE id = $1`, [kid]);
      await client.query(`UPDATE public.jwks SET "privateKey" = 'destroyed' WHERE id = $1`, [kid]);
    }
    const retired = await client.query<GenerationRow>(
      `SELECT ${GENERATION_COLUMNS} FROM public.rezics_signing_key WHERE id = $1`, [kid]);
    return generation(retired.rows[0]!);
  });
}

/** The latest 32 generations for the operator, without key material, after
 * recording the retirement of keys whose verification window has closed. */
export async function signingKeyStatus(pool: Pool): Promise<SigningKeyGeneration[]> {
  return withLock(pool, async client => {
    const rows = await client.query<GenerationRow>(`SELECT ${GENERATION_COLUMNS}
      FROM public.rezics_signing_key ORDER BY generation DESC LIMIT 32`);
    return rows.rows.map(generation);
  });
}

/** Introspection's signing-key decision: one primary-key read. The token's key
 * must be active, or retiring within its verification window, and the token
 * must have been issued while that key signed. The read takes no row lock, so
 * live traffic never delays a rotation or retirement; each applies to every
 * introspection that reads after it commits. */
export async function signingKeyAccepts(client: PoolClient, kid: string,
  issuedAt: number): Promise<boolean> {
  const key = await client.query<{ state: string; activated: string | null;
    superseded: string | null; verifiable: boolean }>(`SELECT state,
      floor(extract(epoch FROM activated_at))::bigint::text AS activated,
      ceil(extract(epoch FROM superseded_at))::bigint::text AS superseded,
      COALESCE(verify_until > now(), false) AS verifiable
    FROM public.rezics_signing_key WHERE id = $1`, [kid]);
  const row = key.rows[0];
  if (!row?.activated || issuedAt < Number(row.activated)) return false;
  if (row.state === 'active') return true;
  return row.state === 'retiring' && row.verifiable && row.superseded !== null
    && issuedAt <= Number(row.superseded) + SIGNING_ALLOWANCE_SECONDS;
}

async function promote(client: PoolClient, successor: string,
  previous: 'retiring' | 'retired'): Promise<SigningKeyGeneration> {
  const superseded = await client.query<{ id: string }>(`UPDATE public.rezics_signing_key
    SET state = $1, superseded_at = now(),
      verify_until = CASE WHEN $1 = 'retiring' THEN now() + make_interval(secs => $2) END,
      retired_at = CASE WHEN $1 = 'retired' THEN now() END,
      retired_reason = CASE WHEN $1 = 'retired' THEN 'compromised' END
    WHERE state = 'active' RETURNING id`, [previous, RETIREMENT_SECONDS]);
  for (const row of superseded.rows) {
    await client.query(`UPDATE public.jwks SET "privateKey" = 'destroyed' WHERE id = $1`, [row.id]);
  }
  const activated = await client.query<GenerationRow>(`UPDATE public.rezics_signing_key
    SET state = 'active', activated_at = now() WHERE id = $1 AND state = 'staged'
    RETURNING ${GENERATION_COLUMNS}`, [successor]);
  return generation(activated.rows[0]!);
}

async function insertKey(client: PoolClient, id: string, data: Omit<Jwk, 'id'>): Promise<void> {
  await client.query(`INSERT INTO public.jwks (id, "publicKey", "privateKey", "createdAt", alg, crv)
    VALUES ($1, $2, $3, now(), $4, $5)`, [id, data.publicKey, data.privateKey,
    data.alg ?? null, data.crv ?? null]);
}

/** Every lifecycle change serializes on one advisory lock and first retires
 * keys whose verification window has closed, destroying nothing further:
 * their private material was destroyed at supersession. */
async function withLock<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(LOCK);
    await client.query(`UPDATE public.rezics_signing_key SET state = 'retired',
        retired_at = verify_until, retired_reason = 'expired'
      WHERE state = 'retiring' AND verify_until <= now()`);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve the lifecycle failure */ }
    throw error;
  } finally { client.release(); }
}

function generation(row: GenerationRow): SigningKeyGeneration {
  return { kid: row.id, generation: row.generation, state: row.state,
    stagedAt: row.staged_at.toISOString(), activatedAt: row.activated_at?.toISOString() ?? null,
    supersededAt: row.superseded_at?.toISOString() ?? null,
    verifyUntil: row.verify_until?.toISOString() ?? null,
    retiredAt: row.retired_at?.toISOString() ?? null, retiredReason: row.retired_reason };
}
