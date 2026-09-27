import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { writeAudit } from './operators.ts';

export const INSTALLATION_CLAIM = 'rezics_installation_id';

export class InstallationConflict extends Error {}
export class InstallationInvalid extends Error {}
export class InstallationNotFound extends Error {}

export interface InstallationView {
  installationId: string;
  clientId: string;
  state: 'active' | 'revoked';
  scopes: string[];
  installedAt: string;
  revokedAt: string | null;
}

type Queryable = Pool | PoolClient;
type InstallationRow = { id: string; client_id: string; state: 'active' | 'revoked';
  scopes: string[]; installed_at: Date; revoked_at: Date | null };

/** The client's active installation and whether its ceiling covers `scopes`.
 * One indexed read of at most one row, without a lock: an access token issued
 * just before a revocation is inactive at its next introspection, and the
 * refresh-token trigger orders refresh writes against revocation itself. */
export async function currentInstallationIn(db: Queryable, clientId: string,
  scopes: readonly string[]): Promise<{ id: string; covers: boolean } | null> {
  const result = await db.query<{ id: string; covers: boolean }>(`SELECT id,
      scopes @> to_jsonb($2::text[]) AS covers
    FROM public.rezics_oauth_installation
    WHERE client_id = $1 AND state = 'active'`, [clientId, [...scopes]]);
  return result.rows[0] ?? null;
}

/** A signed token keeps the installation current at its issuance. It stays
 * active only while that exact installation is active and still covers the
 * token's scopes; a reinstalled App never revives it. Like the key check, this
 * read takes no lock and observes every revocation committed before it. */
export async function installationBasisActive(client: PoolClient,
  payload: Record<string, unknown>, clientId: string, scopes: readonly string[]): Promise<boolean> {
  const installationId = payload[INSTALLATION_CLAIM];
  if (typeof installationId !== 'string') return false;
  const current = await client.query(`SELECT 1 FROM public.rezics_oauth_installation
    WHERE id = $1 AND client_id = $2 AND state = 'active'
      AND scopes @> to_jsonb($3::text[])`, [installationId, clientId, [...scopes]]);
  return current.rowCount === 1;
}

/** The active installation, or else the most recent revoked one. */
export async function readInstallation(pool: Pool, clientId: string): Promise<InstallationView> {
  const result = await pool.query<InstallationRow>(`SELECT id, client_id, state, scopes,
      installed_at, revoked_at FROM public.rezics_oauth_installation
    WHERE client_id = $1 ORDER BY (state = 'active') DESC, installed_at DESC, id DESC LIMIT 1`,
  [clientId]);
  if (!result.rows[0]) throw new InstallationNotFound('installation not found');
  return view(result.rows[0]);
}

/** Terminal. Row locks order this against token, code and refresh writes that
 * share-lock the installation: those commit first or fail after it. An exact
 * retry returns the revoked installation. */
export async function revokeInstallation(pool: Pool, input: {
  installationId: string; operatorUserId: string;
}): Promise<InstallationView> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const before = await db.query<InstallationRow>('SELECT * FROM rezics_oauth_installation WHERE id = $1 FOR UPDATE', [input.installationId]);
    if (!before.rows[0]) throw new InstallationNotFound('installation not found');
    const revoked = await db.query<InstallationRow>(`UPDATE public.rezics_oauth_installation
    SET state = 'revoked', revoked_by = $2, revoked_at = now()
    WHERE id = $1 AND state = 'active'
    RETURNING id, client_id, state, scopes, installed_at, revoked_at`,
  [input.installationId, input.operatorUserId]);
    const after = view(revoked.rows[0] ?? before.rows[0]);
    await writeAudit(db, { actorId: input.operatorUserId, action: 'installation_revoked', targetId: input.installationId,
      reason: 'Operator revoked App installation', before: view(before.rows[0]), after, requestId: randomUUID() });
    await db.query('COMMIT');
    return after;
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}

/** A new installation identity with an explicit ceiling inside the App's
 * current registration. It never replaces an active installation: changing a
 * ceiling is revoke then install, so every token family re-authorizes. The
 * operator's change key makes an exact retry return the original result. */
export async function installClient(pool: Pool, input: {
  clientId: string; scopes: readonly string[]; changeKey: string; operatorUserId: string;
}): Promise<InstallationView> {
  const scopes = [...new Set(input.scopes)].sort();
  if (!scopes.length || scopes.length !== input.scopes.length
    || scopes.some(scope => !/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(scope))) {
    throw new InstallationInvalid('installation scopes must be distinct OAuth scope tokens');
  }
  const digest = createHash('sha256').update(JSON.stringify([input.clientId, scopes])).digest('hex');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const registration = await client.query<{ declared: string[] }>(`SELECT
        public.rezics_declared_scopes(scopes, "clientCredentialsScopes") AS declared
      FROM public."oauthClient" WHERE "clientId" = $1 FOR UPDATE`, [input.clientId]);
    if (!registration.rows[0]) throw new InstallationNotFound('client not found');
    const replay = await client.query<InstallationRow & { change_digest: string }>(`SELECT id,
        client_id, state, scopes, installed_at, revoked_at, change_digest
      FROM public.rezics_oauth_installation WHERE client_id = $1 AND change_key = $2`,
    [input.clientId, input.changeKey]);
    if (replay.rows[0]) {
      if (replay.rows[0].change_digest !== digest) {
        throw new InstallationConflict('change key was used for a different installation');
      }
      await client.query('COMMIT');
      return view(replay.rows[0]);
    }
    const declared = new Set(registration.rows[0].declared);
    if (scopes.some(scope => !declared.has(scope))) {
      throw new InstallationInvalid('installation scopes exceed the App registration');
    }
    const active = await client.query(`SELECT 1 FROM public.rezics_oauth_installation
      WHERE client_id = $1 AND state = 'active'`, [input.clientId]);
    if (active.rowCount) throw new InstallationConflict('revoke the active installation first');
    const inserted = await client.query<InstallationRow>(`INSERT INTO public.rezics_oauth_installation
        (id, client_id, state, scopes, installed_by, change_key, change_digest)
      VALUES ($1, $2, 'active', to_jsonb($3::text[]), $4, $5, $6)
      RETURNING id, client_id, state, scopes, installed_at, revoked_at`,
    [randomUUID(), input.clientId, scopes, input.operatorUserId, input.changeKey, digest]);
    const after = view(inserted.rows[0]!);
    await writeAudit(client, { actorId: input.operatorUserId, action: 'installation_created', targetId: input.clientId,
      reason: 'Operator installed App scopes', before: null, after, requestId: randomUUID() });
    await client.query('COMMIT');
    return after;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve the change failure */ }
    throw error;
  } finally { client.release(); }
}

function view(row: InstallationRow): InstallationView {
  return { installationId: row.id, clientId: row.client_id, state: row.state,
    scopes: [...row.scopes].sort(), installedAt: row.installed_at.toISOString(),
    revokedAt: row.revoked_at?.toISOString() ?? null };
}
