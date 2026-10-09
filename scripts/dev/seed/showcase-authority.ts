import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { grantFixtureAuthority, rethrowFixtureAuthority } from '../../../services/main/src/modules/access/fixture-authority.ts';
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
      try {
        await grantFixtureAuthority(client, {
          scope, requireDispatch: true,
          representations: [{ principalId: owner, actor: input.actingSubject, action, lifetime: '8 hours' }],
          grant: { actor: input.actingSubject, action, lifetime: '8 hours' },
        });
      } catch (error) {
        rethrowFixtureAuthority(error, { gate: `Showcase seed grant gate is closed: ${scope}` });
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve first error */ }
    throw error;
  } finally { client.release(); await pool.end(); }
}
