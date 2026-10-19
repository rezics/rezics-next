import type { Pool } from 'pg';
import { contentConnection, contentSessionClient } from '../../../../content/src/connection.ts';
import type { DatasetFieldPlan } from '../../../../../scripts/datasets/native/fields.ts';
import type { DatasetRecord } from '../../../../../scripts/datasets/types.ts';
import { canonicalJson } from '../../../../../scripts/lib/canonical-json.ts';
import type { SourceIntakeStore, StagedSourceObservation } from './intake.ts';
import { conversionChanged, mappingUnverified, sourceNotFound, supportUnavailable,
  type RetainedConversionRequest, type RetainedRecordBinding } from './field-support-contract.ts';
import { canonicalDigest, SOURCE_NORMALIZATION, sourceId, sourceIri,
  verifyRetainedRecord } from './retained-record-normalization.ts';

export interface RetainedConversion {
  profile: 'source-retained-record-conversion-v1'; state: 'staged'; conversion: string;
  observation: string; mappingRevision: string; sourceDigest: string;
  retainedRecord: RetainedRecordBinding; fieldInventory: RetainedInventory[]; createdAt: string;
}
export interface RetainedInventory {
  grain: string; field: string; pointer: string; disposition: string; reason: string;
  role: string; ordinal?: number; language?: string | null;
}
interface RetainedRow {
  id: string; conversion_id: string; principal_id: string; record_id: string;
  request: RetainedConversionRequest; request_digest: string; normalization_revision: string;
  normalization_rule: string; created_at: Date; field_inventory: RetainedInventory[];
  projection?: { profile: string; recordDigest: string; inventoryDigest?: string };
}
export interface RetainedFieldCustody {
  request: RetainedConversionRequest; observations: StagedSourceObservation[];
  sourceRecord: string;
}

export async function retainedFieldPlan(request: RetainedConversionRequest): Promise<DatasetFieldPlan> {
  // Producer adapters also serve the offline dataset tooling. Loading the pure
  // projection on demand keeps acquisition dependencies out of Main bootstrap.
  const { projectDatasetFields } = await import('../../../../../scripts/datasets/native/fields.ts');
  const { identity, snapshot, recordDigest, intakes, record } = request.retained;
  return projectDatasetFields(record, { ...identity, provider: record.provider, snapshot: snapshot.id,
    snapshotDigest: snapshot.digest, recordDigest,
    observations: intakes.map(part => part.observation),
    intakes: intakes.map(({ index: _index, ...part }) => part) });
}
export async function retainedInventory(request: RetainedConversionRequest): Promise<RetainedInventory[]> {
  return (await retainedFieldPlan(request)).fields.flatMap(field => field.evidence.map(evidence => ({
    grain: request.retained.identity.namespace,
    field: evidence.path.slice(1), pointer: evidence.path,
    disposition: field.disposition, reason: field.reason, role: field.role,
    ...(Object.hasOwn(evidence, 'language') ? { language: evidence.language } : {}),
    ...(evidence.ordinal !== undefined ? { ordinal: evidence.ordinal } : {}) })))
    .sort((left, right) => {
      const a = canonicalJson(left), b = canonicalJson(right);
      return a < b ? -1 : a > b ? 1 : 0;
    });
}
function binding(row: RetainedRow): RetainedRecordBinding {
  const { record: _record, ...retained } = row.request.retained;
  return { ...retained, profile: 'source-retained-record-binding-v1', binding: sourceIri(row.id),
    sourceRecord: sourceIri(row.record_id), conversion: sourceIri(row.conversion_id),
    mappingRevision: row.request.mappingRevision, normalizationRevision: row.normalization_revision };
}
function result(row: RetainedRow): RetainedConversion {
  return { profile: 'source-retained-record-conversion-v1', state: 'staged',
    conversion: sourceIri(row.conversion_id), observation: row.request.retained.intakes[0]!.observation,
    mappingRevision: row.request.mappingRevision, sourceDigest: row.request.retained.payload.byteDigest,
    retainedRecord: binding(row), fieldInventory: row.field_inventory, createdAt: row.created_at.toISOString() };
}

/** Retained conversion extends Source's conversion owner. Its record is the
 * original provider identity; no chunk observation is relabelled as that record. */
export class SourceRetainedRecordStore {
  constructor(private readonly pool: Pool, private readonly intake: Pick<SourceIntakeStore, 'read'>) {}

  private async observations(principalId: string, request: RetainedConversionRequest): Promise<StagedSourceObservation[]> {
    const parts = request.retained.intakes;
    if (!Array.isArray(parts) || !parts.length || parts.length > 512) return supportUnavailable();
    // A single bounded owner lookup for every part, preserving the supplied order.
    const observations: StagedSourceObservation[] = [];
    for (const part of parts) {
      const id = typeof part.observation === 'string' && sourceId(part.observation);
      if (!id) return sourceNotFound();
      const observation = await this.intake.read(principalId, id);
      if (!observation) return sourceNotFound();
      observations.push(observation);
    }
    return observations;
  }

  async convert(principalId: string, observationId: string, request: RetainedConversionRequest):
    Promise<{ conversion: RetainedConversion; replayed: boolean }> {
    if (!sourceId(principalId) || !sourceId(observationId)) return sourceNotFound();
    const observations = await this.observations(principalId, request);
    if (request.retained.intakes[0]?.observation !== sourceIri(observationId)) return conversionChanged('part-order');
    const verified = verifyRetainedRecord(request, observations);
    const registered = (await contentConnection(this.pool).query<{ normalization_revision: string }>(
      `SELECT normalization_revision FROM source.field_mapping WHERE mapping_revision = $1
        AND provider = $2 AND namespace = $3`,
      [request.mappingRevision, request.retained.identity.provider, request.retained.identity.namespace])).rows[0];
    if (registered?.normalization_revision !== verified.normalizationRevision) return mappingUnverified();
    const requestDigest = canonicalDigest({ domain: 'source-retained-record-conversion-v1', principalId, request });
    const fieldInventory = await retainedInventory(request);
    const borrowed = contentSessionClient(this.pool), client = borrowed ?? await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const { identity } = request.retained;
      await client.query(`INSERT INTO source.record (id,provider,namespace,external_id)
        VALUES ($1,$2,$3,$4) ON CONFLICT (provider,namespace,external_id) DO NOTHING`,
      [Bun.randomUUIDv7(), identity.provider, identity.namespace, identity.externalId]);
      const record = (await client.query<{ id: string }>(`SELECT id FROM source.record
        WHERE provider=$1 AND namespace=$2 AND external_id=$3`,
      [identity.provider, identity.namespace, identity.externalId])).rows[0];
      if (!record) return supportUnavailable();
      const inserted = await client.query<{ id: string }>(`INSERT INTO source.conversion
        (id,observation_id,principal_id,mapping_revision,source_digest,projection,field_inventory)
        VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (observation_id,mapping_revision) DO NOTHING RETURNING id`,
      [Bun.randomUUIDv7(), observationId, principalId, request.mappingRevision, request.retained.payload.byteDigest,
        JSON.stringify({ profile: 'source-retained-record-projection-v1', recordDigest: request.retained.recordDigest,
          inventoryDigest: canonicalDigest(fieldInventory) }),
        JSON.stringify(fieldInventory)]);
      const conversion = (await client.query<{ id: string }>(`SELECT id FROM source.conversion
        WHERE observation_id=$1 AND mapping_revision=$2 AND principal_id=$3`,
      [observationId, request.mappingRevision, principalId])).rows[0];
      if (!conversion) return supportUnavailable();
      await client.query(`INSERT INTO source.retained_record_binding
        (id,conversion_id,principal_id,record_id,request,request_digest,normalization_revision,normalization_rule)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (conversion_id) DO NOTHING`,
      [Bun.randomUUIDv7(), conversion.id, principalId, record.id, JSON.stringify(request), requestDigest,
        verified.normalizationRevision, verified.rule]);
      const row = (await client.query<RetainedRow>(`SELECT b.*,c.field_inventory FROM source.retained_record_binding b
        JOIN source.conversion c ON c.id=b.conversion_id WHERE b.conversion_id=$1 AND b.principal_id=$2`,
      [conversion.id, principalId])).rows[0];
      if (!row) return supportUnavailable();
      if (row.request_digest !== requestDigest) return conversionChanged('record');
      await client.query('COMMIT');
      return { conversion: result(row), replayed: inserted.rowCount === 0 };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { if (!borrowed) client.release(); }
  }

  async read(principalId: string, conversionId: string): Promise<RetainedConversion | null> {
    const evidence = await this.evidence(principalId, conversionId);
    return evidence?.conversion ?? null;
  }

  /** Custody is checked before rights, and rights before any private mismatch
   * diagnosis. This lookup does not claim that the retained normalization passed. */
  async custody(principalId: string, conversionId: string): Promise<RetainedFieldCustody | null> {
    const id = sourceId(conversionId);
    if (!sourceId(principalId) || !id) return sourceNotFound();
    const row = (await contentConnection(this.pool).query<RetainedRow>(
      'SELECT * FROM source.retained_record_binding WHERE conversion_id=$1 AND principal_id=$2',
      [id,principalId])).rows[0];
    return row ? { request: row.request, observations: await this.observations(principalId,row.request),
      sourceRecord: sourceIri(row.record_id) } : null;
  }

  async evidence(principalId: string, conversionId: string): Promise<{
    conversion: RetainedConversion; request: RetainedConversionRequest;
    record: DatasetRecord; payload: Record<string, unknown>; rule: string; observations: StagedSourceObservation[];
  } | null> {
    const id = sourceId(conversionId);
    if (!sourceId(principalId) || !id) return sourceNotFound();
    const row = (await contentConnection(this.pool).query<RetainedRow>(`SELECT b.*,c.field_inventory,c.projection
      FROM source.retained_record_binding b JOIN source.conversion c ON c.id=b.conversion_id
      WHERE b.conversion_id=$1 AND b.principal_id=$2 AND c.principal_id=b.principal_id`, [id, principalId])).rows[0];
    if (!row) return null;
    if (row.normalization_revision !== SOURCE_NORMALIZATION
      || row.request_digest !== canonicalDigest({ domain: 'source-retained-record-conversion-v1', principalId, request: row.request })) return supportUnavailable();
    const observations = await this.observations(principalId, row.request);
    const verified = verifyRetainedRecord(row.request, observations);
    // The immutable inventory is the projection made at conversion time, not a
    // fresh projection through today's producer. New native admissions verify
    // their exact field/value separately; a mapper update cannot rewrite replay.
    if (verified.rule !== row.normalization_rule
      || row.projection?.profile !== 'source-retained-record-projection-v1'
      || row.projection.recordDigest !== row.request.retained.recordDigest
      || (row.projection.inventoryDigest !== undefined
        && row.projection.inventoryDigest !== canonicalDigest(row.field_inventory))) return supportUnavailable();
    return { conversion: result(row), request: row.request, ...verified, observations };
  }
}
