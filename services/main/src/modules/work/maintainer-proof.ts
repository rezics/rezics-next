import type { PoolClient } from 'pg';
import type { GraphTerminalProof } from '../access/admission.ts';
import type { BaselineProof } from '../access/baseline.ts';

/** Maintainership belongs to an Agent, including an Organization. Its current
 * controller needs a verified Account at the admission boundary. Unlike the
 * general member policy, this narrow authority may use a delegated control
 * mandate; membership alone still cannot select another Agent's Work. */
export async function maintainerControllerProof(client: PoolClient, principalId: string,
  actingSubject: string): Promise<BaselineProof | null> {
  return (await client.query<BaselineProof>(`SELECT b.generation AS policy_generation,
      a.id AS provision_id, r.id AS representation_id, r.generation AS representation_generation,
      s.generation AS subject_generation, p.enforcement_epoch AS principal_epoch,
      false AS collection_create, NULL::text AS related_work, NULL::text AS source_revision,
      NULL::text AS maintainer_generation
    FROM access.authority_subject s
    JOIN access.agent_provision a ON a.agent_id = s.id AND a.state = 'active'
    JOIN access.representation r ON r.subject_id = s.id AND r.principal_id = $1
    JOIN access.principal p ON p.id = r.principal_id
    JOIN access.baseline_member_policy b ON b.id = 'baseline-member-v1'
    WHERE s.id = $2 AND s.active AND s.kind = 'agent' AND p.active AND b.active
      AND r.action = 'agent.control' AND r.active AND r.valid_until > clock_timestamp()
    ORDER BY r.id LIMIT 1 FOR SHARE OF p, r, s, b`, [principalId, actingSubject])).rows[0] ?? null;
}

/** Called only by the admission sealer after checking the Work or chapter receipt family.
 * Replay cannot re-add a creator who subsequently transferred maintainership. */
export async function recordInitialMaintainer(client: PoolClient, admission: {
  id: string; principal_id: string; acting_subject: string; action: string; scope_id: string;
}, proof: GraphTerminalProof & { work?: string; mainVersion?: string;
  chapterWork?: string; chapterMainVersion?: string; post?: string }): Promise<void> {
  if (proof.outcome !== 'succeeded') return;
  const chapter = admission.action === 'work.edit' && (proof.post || proof.chapterWork && proof.chapterMainVersion)
    && admission.scope_id !== `work:edit:${proof.post ?? proof.chapterWork}`;
  if (admission.action !== 'work.create' && !chapter) return;
  const work = chapter ? proof.post ?? proof.chapterWork! : proof.work;
  // The legacy non-null column is a selection fence key; a Post uses its own
  // resource IRI and never acquires a Main Version in the graph.
  const mainVersion = chapter ? proof.post ?? proof.chapterMainVersion! : proof.mainVersion;
  if (!work || !mainVersion) return;
  const created = await client.query(`INSERT INTO access.work_maintainer_set
    (work, main_version, creation_admission) VALUES ($1,$2,$3)
    ON CONFLICT (work) DO NOTHING RETURNING work`, [work, mainVersion, admission.id]);
  if (!created.rowCount) return;
  await client.query('INSERT INTO access.work_maintainer (work, agent) VALUES ($1,$2)',
    [work, admission.acting_subject]);
  await client.query(`INSERT INTO access.work_maintainer_receipt
    (id, work, principal_id, idempotency_key, request_digest, actor, target, action, generation, maintainers)
    VALUES ($1,$2,$3,$4,$5,$6,$6,'create',0,$7)`, [admission.id, work, admission.principal_id,
    `${chapter ? 'chapter-create' : 'work-create'}:${admission.id}`, proof.requestDigest, admission.acting_subject,
    JSON.stringify([admission.acting_subject])]);
}

/** Two indexed singleton lookups; no enumeration of an Agent's other Works.
 * The set lock orders registration/claim with maintainership transfer. */
export async function maintainerGeneration(client: PoolClient, mainVersion: string,
  work: string, actor: string): Promise<string | null> {
  const result = await client.query<{ generation: string }>(`SELECT s.generation::text
    FROM access.work_maintainer_set s JOIN access.work_maintainer m ON m.work = s.work
    WHERE s.work = $1 AND s.main_version = $2 AND m.agent = $3 FOR SHARE OF s`,
  [work, mainVersion, actor]);
  return result.rows[0]?.generation ?? null;
}
