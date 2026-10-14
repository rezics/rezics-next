import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { checkedResourceReference, ContentAdoptionInvalid, resourceReferenceProjection, type ContentSelection, type ResourceReference } from './adoption.ts';
import { ContentConflict } from './errors.ts';

export const DERIVATION_COST = { inputs: 16, page: 20 } as const;
export type DerivationActivityKind = 'transcription' | 'translation' | 'transformation' | 'ai-generation';
export interface ContentDerivationInput {
  output: ContentSelection; inputs: ResourceReference[];
  activity: { kind: DerivationActivityKind }; responsibleAgent: string; expectedOutputHead: string;
}
export interface ContentDerivationRecord {
  derivation: string; output: ContentSelection; inputs: ResourceReference[];
  activity: { id: string; kind: DerivationActivityKind }; responsibleAgent: string;
  responsibleAgentType: 'human' | 'software';
}
export function checkedDerivation(value: ContentDerivationInput): ContentDerivationInput {
  checkedResourceReference(value.output, true);
  if (value.output.selector.grain !== 'content' || value.output.selector.span
    || !Array.isArray(value.inputs) || !value.inputs.length || value.inputs.length > DERIVATION_COST.inputs
    || !['transcription', 'translation', 'transformation', 'ai-generation'].includes(value.activity.kind)
    || value.expectedOutputHead !== value.output.selector.revision
    || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(value.responsibleAgent))
    throw new ContentAdoptionInvalid('invalid exact Content derivation');
  for (const input of value.inputs) checkedResourceReference(input, true);
  return value;
}
export class ContentDerivationStale extends ContentConflict {}
function digest(value: unknown): string {
  const sorted = (v: unknown): unknown => Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object'
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, item]) => [k, sorted(item)])) : v;
  return createHash('sha256').update(JSON.stringify(sorted(value))).digest('hex');
}
/** Content stores the immutable public credit, separately from private submitter retry identity. */
export class ContentDerivations {
  constructor(private readonly pool: Pool) {}
  async record(operation: string, input: ContentDerivationInput, agentType: 'human' | 'software',
    prove: () => Promise<void>): Promise<ContentDerivationRecord & { replayed: boolean }> {
    checkedDerivation(input); const requestDigest = digest(input); const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'"); await client.query("SET LOCAL statement_timeout = '5s'");
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`content-derivation:${operation}`]);
      const old = (await client.query<{ request_digest: string; record: ContentDerivationRecord }>(
        'SELECT request_digest,record FROM content.derivation WHERE operation_id=$1', [operation])).rows[0];
      if (old) {
        if (old.request_digest !== requestDigest) throw new ContentConflict('derivation retry payload differs');
        await prove(); await client.query('COMMIT'); return { ...old.record, replayed: true };
      }
      const s = input.output.selector;
      const output = (await client.query<{ draft_head: string; availability: string }>(`SELECT v.draft_head,r.availability
        FROM content.variant v JOIN content.revision r ON r.variant_id=v.id
        WHERE v.resource_id=$1 AND v.id=$2 AND r.id=$3 FOR SHARE OF v,r`,
      [input.output.target, s.variantId, s.revision])).rows[0];
      if (!output || output.availability !== 'available') throw new ContentConflict('output revision is unavailable');
      if (output.draft_head !== input.expectedOutputHead) throw new ContentDerivationStale('output head changed');
      await prove();
      const record: ContentDerivationRecord = { derivation: `urn:rezics:content:derivation:${randomUUID()}`,
        output: input.output, inputs: input.inputs, activity: { id: `urn:rezics:activity:${randomUUID()}`, kind: input.activity.kind },
        responsibleAgent: input.responsibleAgent, responsibleAgentType: agentType };
      await client.query(`INSERT INTO content.derivation (id,output_revision,operation_id,request_digest,record)
        VALUES ($1,$2,$3,$4,$5::jsonb)`, [record.derivation, s.revision, operation, requestDigest, JSON.stringify(record)]);
      await client.query('COMMIT'); return { ...record, replayed: false };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async page(revision: string, limit: number, after: string | null): Promise<ContentDerivationRecord[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > DERIVATION_COST.page) throw new ContentAdoptionInvalid('invalid derivation page');
    return (await this.pool.query<{ record: ContentDerivationRecord }>(`SELECT record FROM content.derivation
      WHERE output_revision=$1 AND ($2::text IS NULL OR ordinal>(SELECT ordinal FROM content.derivation
        WHERE id=$2 AND output_revision=$1)) ORDER BY ordinal LIMIT $3`, [revision, after, limit + 1])).rows.map(row => row.record);
  }
}

export function derivationProjection(record: ContentDerivationRecord): Record<string, unknown> {
  const prov = 'http://www.w3.org/ns/prov#';
  return { '@id': record.derivation, output: { ...resourceReferenceProjection(record.output),
    [`${prov}qualifiedDerivation`]: record.inputs.map(input => ({ '@type': `${prov}Derivation`,
      [`${prov}entity`]: resourceReferenceProjection(input), [`${prov}hadActivity`]: { '@id': record.activity.id } })),
    [`${prov}wasGeneratedBy`]: { '@id': record.activity.id } },
  activity: { '@id': record.activity.id, '@type': `${prov}Activity`, kind: record.activity.kind,
    [`${prov}used`]: record.inputs.map(resourceReferenceProjection), [`${prov}wasAssociatedWith`]: { '@id': record.responsibleAgent,
      '@type': `${prov}${record.responsibleAgentType === 'software' ? 'SoftwareAgent' : 'Person'}` } } };
}
