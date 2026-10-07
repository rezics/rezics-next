import type { Pool, PoolClient } from 'pg';
import { AdmissionDenied, AdmissionUnavailable, type VerifiedPrincipal } from './admission.ts';
import { realmMemberProof } from '../realm-reply/member-policy.ts';
import { realmPolicyDeliveryHead, type RealmReviewMode, type RealmVisibility } from '../space/policy.ts';
import { spaceCreationReceiptIri } from '../space/create.ts';
import type { RealmHistoryFloor } from '../realm-admin/history.ts';

export interface RealmPermit { visibility: RealmVisibility; reviewMode: RealmReviewMode;
  member: boolean; revision: string | null; stamp: string; historyFloor: RealmHistoryFloor | null }

/** All policy and membership reads are indexed point probes. Hold the Realm
 * gate through a bounded Content/graph write so settings cannot acknowledge a
 * transition while an older admitted write is still being published. */
export async function realmPermit(client: PoolClient, principal: VerifiedPrincipal,
  actor: string, realm: string, purpose: 'read' | 'reply' | 'submission'): Promise<RealmPermit> {
  const gate = (await client.query(`SELECT authority_epoch::text FROM access.scope_gate
    WHERE id = $1 AND open AND dispatch_open FOR SHARE`, [`governance:realm:${realm}`])).rows[0];
  const identity = (await client.query(`SELECT p.id,p.enforcement_epoch::text,r.id AS representation,
    r.generation::text,s.generation::text AS subject_generation FROM access.principal p
    JOIN access.representation r ON r.principal_id = p.id AND r.subject_id = $3
      AND r.active AND r.valid_until > clock_timestamp()
    JOIN access.authority_subject s ON s.id = r.subject_id AND s.kind = 'agent' AND s.active
    WHERE p.account_issuer = $1 AND p.account_subject = $2 AND p.active
    ORDER BY r.id LIMIT 1 FOR SHARE OF p,r,s`, [principal.issuer, principal.subject, actor])).rows[0];
  if (!identity) throw new AdmissionDenied('Realm actor is unavailable');
  const settings = (await client.query<{ visibility: RealmVisibility; review_mode: RealmReviewMode;
    who_may_submit: string; history: string }>(`SELECT visibility,review_mode,who_may_submit,history
    FROM access.realm_admin_settings WHERE realm = $1 FOR SHARE`, [realm])).rows[0];
  const delivery = (await client.query<{ receipt_id: string; policy_head: string | null; delivered: boolean; admission_id: string | null }>(`
    SELECT d.receipt_id, d.policy_head, d.delivered, i.admission_id::text
    FROM access.realm_policy_delivery d
    LEFT JOIN access.realm_creation_initialization i
      ON i.realm = d.realm AND i.policy_receipt = d.receipt_id
    WHERE d.realm = $1`, [realm])).rows[0];
  if (delivery && (!gate || !delivery.delivered)) throw new AdmissionUnavailable('Realm policy is being published');
  const ban = await client.query(`SELECT 1 FROM access.membership_ban WHERE kind = 'realm'
    AND owner_subject = $1 AND member_subject = $2 AND active
      AND (expires_at IS NULL OR expires_at > clock_timestamp())
    UNION ALL SELECT 1 FROM access.private_membership_ban WHERE kind = 'realm'
      AND owner_subject = $1 AND principal_id = $3 AND active LIMIT 1`, [realm, actor, identity.id]);
  if (ban.rowCount) throw new AdmissionDenied('Realm member is banned');
  const member = await realmMemberProof(client, realm, identity.id, actor);
  const owner = (await client.query(`SELECT id,generation::text FROM access.permission_grant
    WHERE scope_id = $1 AND recipient_subject = $2 AND action = 'realm.owner'
      AND active AND valid_until > clock_timestamp() AND membership_id IS NULL
    ORDER BY id LIMIT 1 FOR SHARE`, [`governance:realm:${realm}`, actor])).rows[0];
  const approved = member ?? (owner ? `owner:${owner.id}:${owner.generation}` : null);
  const visibility = settings?.visibility ?? 'public';
  // Read permits are deliberately membership-only: the graph decides whether
  // one is needed. A pending private->public Access value cannot grant a read.
  if ((purpose === 'read' || visibility !== 'public') && !approved
    || purpose === 'submission' && (settings?.who_may_submit === 'closed'
      || settings?.who_may_submit === 'members' && !approved)) throw new AdmissionDenied('Realm membership is required');
  let historyFloor: RealmHistoryFloor | null = null;
  if (purpose === 'read' && visibility === 'private' && settings?.history === 'from-admission' && !owner) {
    const [kind, id, generation] = member!.split(':');
    const row = (await client.query<{ data_epoch: string; sequence: string }>(`SELECT data_epoch,sequence::text
      FROM access.realm_history_admission WHERE kind = $1 AND membership_id = $2 AND generation = $3`,
    [kind === 'private' ? 'private' : 'agent',id,generation])).rows[0];
    // Earlier episodes and joins under everything retain their full history.
    historyFloor = row ? { dataEpoch: row.data_epoch, sequence: row.sequence } : null;
  }
  // Creation keeps its original command receipt; ordinary publications use
  // their stored exact head, with the legacy fallback only for older rows.
  return { visibility, reviewMode: settings?.review_mode ?? 'mandatory', member: !!approved, historyFloor,
    revision: !delivery ? null : delivery.admission_id
      ? spaceCreationReceiptIri(delivery.admission_id) : realmPolicyDeliveryHead(delivery),
    stamp: JSON.stringify([identity, gate?.authority_epoch ?? null, approved, delivery?.receipt_id ?? null]) };
}

export async function withRealmPermit<T>(pool: Pool, principal: VerifiedPrincipal, actor: string, realm: string,
  purpose: 'read' | 'reply' | 'submission', operation: (permit: RealmPermit, client?: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const recovery = await client.query('SELECT 1 FROM access.recovery_fence WHERE id AND open FOR SHARE');
    if (!recovery.rowCount) throw new AdmissionUnavailable('Access recovery is in progress');
    const permit = await realmPermit(client, principal, actor, realm, purpose);
    const result = await operation(permit, client);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}
