import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import type { LocalOperatorInput } from './operator.ts';

const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
export type ShowcaseGrant = { action: 'media.upload' | 'media.labels'; scope: `media:owner:${string}` }
  | { action: 'media.avatar'; scope: `media:avatar:${string}` };

async function principal(client: PoolClient, issuer: string, accountSubject: string) {
  const found = await client.query<{ id: string }>(`SELECT id FROM access.principal
    WHERE account_issuer = $1 AND account_subject = $2 AND active FOR SHARE`, [issuer, accountSubject]);
  if (found.rows[0]) return found.rows[0].id;
  const id = randomUUID();
  await client.query(`INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1,$2,$3)`,
    [id, issuer, accountSubject]);
  return id;
}

async function ensureRepresentation(client: PoolClient, principalId: string, actor: string, action: string) {
  const found = await client.query(`SELECT id FROM access.representation
    WHERE principal_id = $1 AND subject_id = $2 AND action = $3 AND active
      AND valid_until > now() FOR SHARE`, [principalId, actor, action]);
  if (found.rowCount) return;
  await client.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
    VALUES ($1,$2,$3,$4,now() + interval '8 hours')`, [randomUUID(), principalId, actor, action]);
}

/**
 * Dev fixture authority for a demo person to upload showcase art, label it
 * and select it on exact Works, the authority that selects a Work's cover. Selection itself
 * still goes through Main's showcase commands.
 */
export async function grantShowcaseSeedAuthority(input: LocalOperatorInput, grants: readonly ShowcaseGrant[]) {
  if (grants.some(({ action, scope }) => action !== 'media.avatar'
    ? scope !== `media:owner:${input.actingSubject}`
    : !native.test(scope.slice('media:avatar:'.length)))) {
    throw new Error('Showcase seed grant is outside the demo person and Works');
  }
  const url = new URL(input.accessDatabaseUrl);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !url.port) {
    throw new Error('Seed operator setup requires a loopback database');
  }
  const pool = new Pool({ connectionString: input.accessDatabaseUrl });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const fence = await client.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
    if (fence.rows[0]?.open !== true) throw new Error('Access recovery fence is closed');
    const owner = await principal(client, `${input.endpoints.account}/api/auth`, input.ownerAccountSubject);
    await client.query(`INSERT INTO access.authority_subject (id, kind) VALUES ($1,'agent')
      ON CONFLICT (id) DO NOTHING`, [input.actingSubject]);
    for (const { action, scope } of grants) {
      await client.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [scope]);
      const gate = await client.query<{ open: boolean; dispatch_open: boolean }>(
        'SELECT open, dispatch_open FROM access.scope_gate WHERE id = $1 FOR SHARE', [scope]);
      if (gate.rows[0]?.open !== true || gate.rows[0]?.dispatch_open !== true) {
        throw new Error(`Showcase seed grant gate is closed: ${scope}`);
      }
      await ensureRepresentation(client, owner, input.actingSubject, action);
      const found = await client.query(`SELECT id FROM access.permission_grant
        WHERE recipient_subject = $1 AND scope_id = $2 AND action = $3 AND active
          AND valid_until > now() FOR SHARE`, [input.actingSubject, scope, action]);
      if (!found.rowCount) await client.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1,$2,$2,$3,$4,now() + interval '8 hours')`, [randomUUID(), input.actingSubject, scope, action]);
    }
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve first error */ }
    throw error;
  } finally { client.release(); await pool.end(); }
}
