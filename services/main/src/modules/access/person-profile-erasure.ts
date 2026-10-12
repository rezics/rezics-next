import type { Pool, PoolClient } from 'pg';
import { lockPreservationTarget } from '../public-report/preservation.ts';

export class PersonProfileErasureDenied extends Error {}
export class PersonProfileErasureStale extends Error {}
export class PersonProfileErasureUnavailable extends Error {}

export interface EndedPersonProvision {
  readonly provisionId: string;
  readonly principalId: string;
  readonly person: string;
  readonly requestDigest: string;
  readonly graphDataEpoch: string;
  readonly graphSequence: string;
  readonly subjectEpoch: string;
}

/** The original parent/child journal and exact retained Access fence, never a
 * newly fabricated admission after Account deletion. */
export interface PersonProfileErasureProof {
  readonly erasureId: string;
  readonly erasureEpoch: string;
  readonly accountErasureId: string;
  readonly principalId: string;
  readonly person: string;
  readonly provisionId: string;
  readonly deletionIntentId: string;
  readonly deletionEnforcementEpoch: string;
  readonly subjectEpoch: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EPOCH = /^[1-9][0-9]{0,18}$/;
function validateProof(proof: PersonProfileErasureProof): void {
  if (![proof.erasureId, proof.accountErasureId, proof.principalId,
    proof.provisionId, proof.deletionIntentId].every(value => UUID.test(value))
    || ![proof.erasureEpoch, proof.deletionEnforcementEpoch, proof.subjectEpoch]
      .every(value => EPOCH.test(value) && BigInt(value) <= 9223372036854775807n)
    || !proof.person.startsWith('https://rezics.com/id/')
    || !UUID.test(proof.person.slice('https://rezics.com/id/'.length))
    || proof.erasureId === proof.accountErasureId) {
    throw new PersonProfileErasureDenied('invalid Person erasure identity');
  }
}

/** Indexed retained identity lookup with a lookahead, so overflow cannot become
 * a silently incomplete closure. The caller owns the one aggregate budget. */
export async function listEndedPersonProvisions(access: Pool | PoolClient, principalId: string,
  limit: number): Promise<readonly EndedPersonProvision[]> {
  if (!UUID.test(principalId) || !Number.isInteger(limit) || limit < 0 || limit > 256) {
    throw new PersonProfileErasureDenied('invalid ended Person inventory bound');
  }
  const rows = (await access.query<EndedPersonProvision>(`SELECT a.id AS "provisionId",
    a.principal_id AS "principalId", a.agent_id AS person, a.request_digest AS "requestDigest",
    a.graph_data_epoch AS "graphDataEpoch", a.graph_sequence::text AS "graphSequence",
    s.generation::text AS "subjectEpoch"
    FROM access.agent_provision a JOIN access.principal p ON p.id = a.principal_id
    JOIN access.authority_subject s ON s.id = a.agent_id
    WHERE a.principal_id = $1 AND a.agent_kind = 'person' AND a.state = 'active'
      AND NOT p.active AND NOT s.active AND s.kind = 'agent'
      AND EXISTS (SELECT 1 FROM access.outbox o WHERE o.principal_id = p.id
        AND o.kind = 'account.deletion_fenced' AND o.authority_epoch = p.enforcement_epoch)
    ORDER BY a.agent_id LIMIT $2`, [principalId, limit + 1])).rows;
  if (rows.length > limit) throw new PersonProfileErasureDenied('ended Person inventory exceeds aggregate budget');
  return rows;
}

interface ProvisionState {
  agent_id: string; principal_id: string; agent_kind: string; state: string;
  display_name: string | null; profile_erasure_id: string | null; profile_erasure_epoch: string | null;
  account_erasure_id: string | null; deletion_intent_id: string | null;
  deletion_enforcement_epoch: string | null; subject_epoch: string | null;
}

/** The journal owner supplies this immutable link. Absence is a dependency refusal, never
 * permission to sanitize against an ordinary Account row or Access admission. */
export async function assertPersonProfileErasureAuthority(client: PoolClient, relay: Pool | PoolClient,
  proof: PersonProfileErasureProof): Promise<void> {
  validateProof(proof);
  const schema = await relay.query(`SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'relay' AND table_name = 'erasure' AND column_name = 'account_erasure_id'`);
  if (!schema.rowCount) throw new PersonProfileErasureUnavailable('Account-child journal link is unavailable');
  const retained = (await relay.query<{ account_issuer: string; account_subject: string }>(`
    SELECT parent.account_issuer, parent.account_subject FROM relay.erasure child
    JOIN relay.erasure parent ON parent.id = child.account_erasure_id
    JOIN relay.account_deletion_intent intent ON intent.principal_id = parent.deleted_principal_id
    WHERE child.id = $1 AND child.erasure_epoch = $2 AND child.account_erasure_id = $3
      AND child.kind = 'resource' AND child.authority = 'account_deletion'
      AND child.operation_id = 'account-profile-erasure:' || parent.id::text
      AND child.suppression_status = 'suppressed'
      AND child.stage IN ('inventory_complete','deleting','reconciling','verified')
      AND parent.kind = 'account' AND parent.authority = 'account_deletion'
      AND parent.suppression_status = 'suppressed' AND parent.deleted_principal_id = $4
      AND intent.outbox_id = $5 AND intent.authority_epoch = $6
      AND EXISTS (SELECT 1 FROM relay.erasure_target t WHERE t.erasure_id = child.id
        AND t.owner = 'access' AND t.target_kind = 'principal' AND t.target_ref = $4::text)
      AND EXISTS (SELECT 1 FROM relay.erasure_target t WHERE t.erasure_id = child.id
        AND t.owner = 'graph' AND t.target_kind = 'person_head' AND t.target_ref = $7)`,
  [proof.erasureId, proof.erasureEpoch, proof.accountErasureId, proof.principalId,
    proof.deletionIntentId, proof.deletionEnforcementEpoch, proof.person])).rows[0];
  if (!retained) throw new PersonProfileErasureDenied('Person erasure does not match its sealed Account-child journal');

  const recovery = (await client.query<{ open: boolean }>(
    'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE')).rows[0];
  if (!recovery?.open) throw new PersonProfileErasureUnavailable('Access recovery fence is closed');
  await lockPreservationTarget(client, proof.person);
  const principal = (await client.query<{ active: boolean; enforcement_epoch: string;
    account_issuer: string; account_subject: string }>(
    'SELECT active, enforcement_epoch, account_issuer, account_subject FROM access.principal WHERE id = $1 FOR SHARE',
    [proof.principalId])).rows[0];
  if (!principal || principal.active || principal.account_issuer !== retained.account_issuer
    || principal.account_subject !== retained.account_subject) {
    throw new PersonProfileErasureDenied('Account erasure principal is active or belongs to another Account');
  }
  if (principal.enforcement_epoch !== proof.deletionEnforcementEpoch) {
    throw new PersonProfileErasureStale('Account deletion enforcement epoch changed');
  }
  const subject = (await client.query<{ active: boolean; kind: string; generation: string }>(
    'SELECT active, kind, generation FROM access.authority_subject WHERE id = $1 FOR SHARE', [proof.person])).rows[0];
  if (!subject || subject.active || subject.kind !== 'agent') {
    throw new PersonProfileErasureDenied('Person authority is not ended');
  }
  if (subject.generation !== proof.subjectEpoch) throw new PersonProfileErasureStale('Person authority generation changed');
  const provision = (await client.query<ProvisionState>(
    'SELECT * FROM access.agent_provision WHERE id = $1 FOR UPDATE', [proof.provisionId])).rows[0];
  if (!provision || provision.agent_kind !== 'person' || provision.state !== 'active'
    || provision.agent_id !== proof.person || provision.principal_id !== proof.principalId) {
    throw new PersonProfileErasureDenied('Person is not the exact retained Account provision');
  }
  if (provision.profile_erasure_id !== null && (provision.profile_erasure_id !== proof.erasureId
    || provision.profile_erasure_epoch !== proof.erasureEpoch || provision.account_erasure_id !== proof.accountErasureId
    || provision.deletion_intent_id !== proof.deletionIntentId
    || provision.deletion_enforcement_epoch !== proof.deletionEnforcementEpoch
    || provision.subject_epoch !== proof.subjectEpoch || provision.display_name !== null)) {
    throw new PersonProfileErasureStale('Person provision has another terminal erasure');
  }
  const fence = await client.query(`SELECT 1 FROM access.outbox WHERE id = $1
    AND principal_id = $2 AND kind = 'account.deletion_fenced' AND authority_epoch = $3 FOR SHARE`,
  [proof.deletionIntentId, proof.principalId, proof.deletionEnforcementEpoch]);
  if (!fence.rowCount) throw new PersonProfileErasureStale('retained Account deletion intent changed');
  const holds = await client.query(`SELECT 1 FROM access.governance_preservation_hold WHERE released_at IS NULL
    AND (target_resource = $1 OR author_subject = $1 OR (account_issuer = $2 AND account_subject = $3)) LIMIT 1`,
  [proof.person, principal.account_issuer, principal.account_subject]);
  if (holds.rowCount) throw new PersonProfileErasureDenied('Person profile is retained under a preservation hold');
  await client.query("SELECT set_config('rezics.person_profile_erasure', $1, true)", [JSON.stringify(proof)]);
}

/** All owner callbacks run under the same rechecked Access neighborhood locks. */
export async function withPersonProfileErasureAuthority<T>(access: Pool, relay: Pool | PoolClient,
  proof: PersonProfileErasureProof, apply: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await access.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    await assertPersonProfileErasureAuthority(client, relay, proof);
    const result = await apply(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (['55P03', '57014', '40P01', '40001'].includes((error as { code?: string }).code ?? '')) {
      throw new PersonProfileErasureStale('Person owner state is concurrently locked');
    }
    throw error;
  } finally { client.release(); }
}

export async function erasePersonProvisionProfile(access: Pool, relay: Pool | PoolClient,
  proof: PersonProfileErasureProof): Promise<void> {
  await withPersonProfileErasureAuthority(access, relay, proof, async client => {
    await client.query(`UPDATE access.agent_provision SET display_name = NULL,
      profile_erasure_id = $2, profile_erasure_epoch = $3, account_erasure_id = $4,
      deletion_intent_id = $5, deletion_enforcement_epoch = $6, subject_epoch = $7
      WHERE id = $1 AND profile_erasure_id IS NULL`, [proof.provisionId, proof.erasureId,
      proof.erasureEpoch, proof.accountErasureId, proof.deletionIntentId,
      proof.deletionEnforcementEpoch, proof.subjectEpoch]);
  });
}

export async function personProvisionProfileErased(access: Pool | PoolClient,
  proof: PersonProfileErasureProof): Promise<boolean> {
  validateProof(proof);
  return (await access.query(`SELECT 1 FROM access.agent_provision WHERE id = $1
    AND agent_id = $2 AND principal_id = $3 AND agent_kind = 'person' AND display_name IS NULL
    AND profile_erasure_id = $4 AND profile_erasure_epoch = $5 AND account_erasure_id = $6
    AND deletion_intent_id = $7 AND deletion_enforcement_epoch = $8 AND subject_epoch = $9`,
  [proof.provisionId, proof.person, proof.principalId, proof.erasureId, proof.erasureEpoch,
    proof.accountErasureId, proof.deletionIntentId, proof.deletionEnforcementEpoch, proof.subjectEpoch])).rowCount === 1;
}
