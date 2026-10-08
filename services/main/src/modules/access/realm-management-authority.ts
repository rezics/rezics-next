import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from './admission.ts';
import { RealmAdminConflict, RealmAdminDenied, RealmAdminInvalid, RealmAdminLimit,
  RealmAdminStale, RealmAdminUnavailable } from '../realm-admin/contract.ts';

export const realmIdPattern = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const realmKeyPattern = /^[A-Za-z0-9:_./-]{1,128}$/;
export interface RealmActor { id: string; epoch: string; representation: string;
  representationGeneration: string; subjectGeneration: string; validUntil: Date }
export interface RealmManager extends RealmActor { grant: string; grantGeneration: string }

/** Lock order matches Realm management: recovery, Realm, then shared membership scope.
 * All reads/writes are bounded; authority rows remain locked until disclosure or commit.
 * See https://www.postgresql.org/docs/current/explicit-locking.html (2026-09-28). */
export async function realmTransaction<T>(pool: Pool, realm: string | null, write: boolean,
  run: (client: PoolClient) => Promise<T>): Promise<T> {
  if (realm !== null && !realmIdPattern.test(realm)) throw new RealmAdminInvalid('Invalid Realm');
  const client = await pool.connect().catch(() => { throw new RealmAdminUnavailable('Access is unavailable'); });
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '2s'");
    // statement_timeout rides the recovery fence this transaction already reads.
    // A separate round trip would put the public roster over its request cap.
    if (!(await client.query(`SELECT set_config('statement_timeout', '5s', true)
      FROM access.recovery_fence WHERE id AND open FOR SHARE`)).rowCount) {
      throw new RealmAdminUnavailable('Access recovery is in progress');
    }
    if (realm && !(await client.query(`SELECT 1 FROM access.scope_gate WHERE id = $1
      AND open AND dispatch_open FOR ${write ? 'UPDATE' : 'SHARE'}`, [`governance:realm:${realm}`])).rowCount) {
      throw new RealmAdminDenied('Realm is unavailable');
    }
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error instanceof RealmAdminDenied || error instanceof RealmAdminInvalid || error instanceof RealmAdminStale
      || error instanceof RealmAdminConflict || error instanceof RealmAdminLimit || error instanceof RealmAdminUnavailable) throw error;
    if ((error as { code?: string }).code === '23505') throw new RealmAdminConflict('The command conflicts with an existing record');
    throw new RealmAdminUnavailable('Realm operation is unavailable');
  } finally { client.release(); }
}

export async function realmActor(client: PoolClient, principal: VerifiedPrincipal, actor: string, action: string): Promise<RealmActor> {
  if (!realmIdPattern.test(actor)) throw new RealmAdminInvalid('Invalid acting Agent');
  const row = (await client.query<RealmActor>(`SELECT p.id,p.enforcement_epoch::text AS epoch,
    r.id AS representation,r.generation::text AS "representationGeneration",
    s.generation::text AS "subjectGeneration",LEAST(r.valid_until,clock_timestamp() + interval '7 days') AS "validUntil"
    FROM access.principal p JOIN access.representation r ON r.principal_id = p.id
      AND r.subject_id = $3 AND r.action IN ($4,'agent.control') AND r.active AND r.valid_until > clock_timestamp()
    JOIN access.authority_subject s ON s.id = r.subject_id AND s.active AND s.kind = 'agent'
    WHERE p.account_issuer = $1 AND p.account_subject = $2 AND p.active
    ORDER BY r.valid_until DESC,r.id LIMIT 1 FOR SHARE OF p,r,s`,
  [principal.issuer,principal.subject,actor,action])).rows[0];
  if (!row) throw new RealmAdminDenied('Acting Agent authority is unavailable');
  return row;
}

export async function realmManager(client: PoolClient, principal: VerifiedPrincipal, realm: string,
  actor: string, action = 'realm.members.manage'): Promise<RealmManager> {
  const identity = await realmActor(client,principal,actor,action);
  const row = (await client.query<{ id: string; generation: string; valid_until: Date }>(`SELECT g.id,
    g.generation::text,LEAST(g.valid_until,clock_timestamp() + interval '7 days') AS valid_until FROM access.permission_grant g
    WHERE g.recipient_subject = $1 AND g.scope_id = $2 AND g.action = $3
      AND g.active AND g.valid_until > clock_timestamp()
      AND (g.membership_id IS NULL OR EXISTS (SELECT 1 FROM access.membership m
        WHERE m.id = g.membership_id AND m.state = 'joined' AND m.generation = g.membership_generation))
    ORDER BY g.valid_until DESC,g.id LIMIT 1 FOR SHARE`, [actor,`governance:realm:${realm}`,action])).rows[0];
  if (!row) throw new RealmAdminDenied('Realm permission is missing');
  return { ...identity,grant: row.id,grantGeneration: row.generation,
    validUntil: new Date(Math.min(identity.validUntil.getTime(),row.valid_until.getTime())) };
}

export async function membershipRoot(client: PoolClient) {
  if (!(await client.query(`SELECT 1 FROM access.scope_gate WHERE id = 'work:create:root'
    AND open AND dispatch_open FOR SHARE`)).rowCount) throw new RealmAdminDenied('Membership authority is unavailable');
}
