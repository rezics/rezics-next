import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { VariantIdentity } from '../../content/src/index.ts';

/** Seed the committed draft shape of the pre-sequencer owner. Today's writer
 * appends unnumbered events and cannot run against that historical schema. */
export async function seedRetainedContentDraft(pool: Pool, variant: VariantIdentity,
  serializedJson: string, provenance: Record<string, unknown> = {}) {
  const revision = randomUUID(), operation = `seed:${randomUUID()}`, bytes = Buffer.from(serializedJson);
  const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const position = (await client.query<{ data_epoch: string; sequence: string }>(`
      UPDATE content.owner_control SET sequence = sequence + 1 WHERE singleton
      RETURNING data_epoch, sequence::text`)).rows[0]!;
    await client.query(`INSERT INTO content.variant
      (id, resource_id, language_kind, language_tag, original_language_tag, direction)
      VALUES ($1,$2,$3,$4,$5,$6)`, [variant.id, variant.resourceId, variant.language.kind,
      variant.language.kind === 'tag' ? variant.language.tag : null,
      variant.language.kind === 'tag' ? variant.language.originalTag : null, variant.direction]);
    await client.query(`INSERT INTO content.revision
      (id, variant_id, operation_id, format, model, provenance, byte_digest, byte_length, serialized_bytes, body)
      VALUES ($1,$2,$3,'rezics-content-json-v1','content-shape-v1',$4::jsonb,$5,$6,$7,$8::jsonb)`,
    [revision, variant.id, operation, JSON.stringify(provenance), digest(bytes), bytes.length, bytes, serializedJson]);
    await client.query('UPDATE content.variant SET draft_head = $2 WHERE id = $1', [variant.id, revision]);
    const receipt = (await client.query<{ revisionId: string; outcome: 'succeeded' }>(`
      INSERT INTO content.receipt
        (operation_id, request_digest, action, outcome, variant_id, revision_id, data_epoch, sequence)
      VALUES ($1,$2,'draft.save','succeeded',$3,$4,$5,$6)
      RETURNING revision_id AS "revisionId", outcome`, [operation,
      digest(JSON.stringify({ variant, serializedJson, provenance })), variant.id, revision,
      position.data_epoch, position.sequence])).rows[0]!;
    await client.query(`INSERT INTO content.outbox
      (id, data_epoch, sequence, operation_id, event_type, recipe, revision_id, payload)
      VALUES ($1,$2,$3,$4,'content.revision.saved','content-body-v1',$5,$6::jsonb)`,
    [randomUUID(), position.data_epoch, position.sequence, operation, revision,
      JSON.stringify({ variantId: variant.id, revisionId: revision, predecessor: null,
        byteDigest: digest(bytes), byteLength: bytes.length })]);
    await client.query('COMMIT');
    return receipt;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
