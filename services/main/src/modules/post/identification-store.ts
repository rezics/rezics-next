import type { Pool } from 'pg';
import type { WorkEditAuthorityProof } from '../access/work-edit-authority.ts';
import { derivedId } from '../structure/graph.ts';
import type { IdentificationInput } from './identification-schema.ts';
import { PostIdentificationConflict, PostIdentificationUnavailable } from './identification-schema.ts';

export interface IdentificationResult {
  profile: 'post-identification-v1'; identification: string; post: string; work: string;
  mainVersion: string; structure: string; occurrence: string; relation: string;
  relationRevision: string; evidence: IdentificationInput['evidence']; receipt: string;
  receipts: { work: string | null; metadata: string | null; structure: string; placement: string; relation: string };
  sourcePosition: { datasetId: 'product'; dataEpoch: string; sequence: string };
}
export interface IdentificationRecord {
  id: string; post: string; request_digest: string; intent: IdentificationInput;
  /** Initial proof source; a retry may satisfy the other allowed authority. */
  authority_resource: string; definition_ref: string; definition_id: string;
  steps: Record<string, unknown>; result: IdentificationResult | null;
}

/** Indexed intent and immutable receipt checkpoints. No lock spans an owner API
 * call. Concurrent retries send the same subkeys and converge on the same proof. */
export class PostIdentifications {
  constructor(private readonly pool: Pool) {}
  async reserve(proof: WorkEditAuthorityProof, post: string, key: string, digest: string,
    intent: IdentificationInput, definition: { revision: string; definition: string }) {
    const id = derivedId(JSON.stringify(['post-identification', proof.principalId, intent.actingSubject, post, key])).slice(-36);
    await this.pool.query(`INSERT INTO access.post_identification
      (id,principal_id,acting_subject,post,idempotency_key,request_digest,intent,authority_resource,definition_ref,definition_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
    [id, proof.principalId, intent.actingSubject, post, key, digest, JSON.stringify(intent),
      proof.scope.slice('work:edit:'.length), definition.revision, definition.definition]);
    const record = await this.read(id);
    if (!record || record.request_digest !== digest) throw new PostIdentificationConflict('Key belongs to another identification');
    return record;
  }
  async read(id: string): Promise<IdentificationRecord | null> {
    return (await this.pool.query<IdentificationRecord>(`SELECT id::text,post,request_digest,intent,
      authority_resource,definition_ref,definition_id,steps,result FROM access.post_identification WHERE id=$1`, [id])).rows[0] ?? null;
  }
  async checkpoint<T>(id: string, step: string, value: T): Promise<T> {
    const rows = (await this.pool.query<{ value: T }>(`UPDATE access.post_identification
      SET steps=jsonb_set(steps,ARRAY[$2]::text[],COALESCE(steps->$2,$3::jsonb))
      WHERE id=$1 RETURNING steps->$2 AS value`, [id, step, JSON.stringify(value)])).rows;
    if (rows.length !== 1) throw new PostIdentificationUnavailable('Identification journal is unavailable');
    return rows[0]!.value;
  }
  async complete(id: string, value: IdentificationResult): Promise<IdentificationResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const changed = (await client.query<{ post: string }>(`UPDATE access.post_identification
        SET result=$2::jsonb WHERE id=$1 AND result IS NULL RETURNING post`, [id, JSON.stringify(value)])).rows[0];
      if (changed) await client.query(`INSERT INTO access.post_identification_inventory(post,generation)
        VALUES ($1,1) ON CONFLICT (post) DO UPDATE SET generation=access.post_identification_inventory.generation+1`, [changed.post]);
      if (changed) await client.query(`INSERT INTO access.post_identification_work(post,work,identification)
        VALUES ($1,$2,$3) ON CONFLICT (post,work) DO UPDATE SET identification=EXCLUDED.identification`,
      [changed.post, value.work, id]);
      const record = (await client.query<{ result: IdentificationResult }>(
        'SELECT result FROM access.post_identification WHERE id=$1', [id])).rows[0];
      if (!record?.result) throw new PostIdentificationUnavailable('Identification receipt is unavailable');
      await client.query('COMMIT'); return record.result;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async position(post: string): Promise<string> {
    return (await this.pool.query<{ generation: string }>(
      'SELECT generation::text FROM access.post_identification_inventory WHERE post=$1', [post])).rows[0]?.generation ?? '0';
  }
  async page(post: string, after: string, limit: number) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 101) throw new PostIdentificationUnavailable('Invalid receipt page size');
    return (await this.pool.query<IdentificationRecord>(`SELECT r.id::text,r.post,r.request_digest,r.intent,
      r.authority_resource,r.definition_ref,r.definition_id,r.steps,r.result FROM access.post_identification_work w
      JOIN access.post_identification r ON r.id=w.identification
      WHERE w.post=$1 AND w.work>$2 ORDER BY w.work LIMIT $3`, [post, after, limit])).rows;
  }
}
