import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Pool } from 'pg';
import type { SourceIntakeStore, StagedSourceObservation } from '../source/intake.ts';

export class RecipeSourceConversionInvalid extends Error {}
export class RecipeSourceConversionUnavailable extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const iri = (id: string) => `https://rezics.com/id/${id}`;
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const SLOT = {
  recipeIngredient: 'structure-occurrence-v1#qualifier.originalText.value',
  recipeInstructions: 'structure-occurrence-v1#qualifier.instructionText.value',
} as const;

export interface RecipeSourceConversion {
  conversion: string;
  observation: string;
  record: string;
  mappingRevision: string;
  sourceDigest: string;
  replayed: boolean;
}

interface ConversionRow {
  id: string; source_digest: string; projection: unknown; field_inventory: unknown;
}

/** A reviewed two-field map is sealed per provider/namespace; unknown keys remain explicit. */
export class RecipeSourceConversionStore {
  constructor(private readonly pool: Pool, private readonly intake: SourceIntakeStore) {}

  async convert(principalId: string, observationId: string): Promise<RecipeSourceConversion | null> {
    if (!UUID.test(principalId) || !UUID.test(observationId)) {
      throw new RecipeSourceConversionInvalid('invalid Recipe source identity');
    }
    const observation = await this.intake.read(principalId, observationId);
    if (!observation) return null;
    const projected = this.project(observation);
    const mapping = `recipe-json-${digest(`${observation.provider}\0${observation.namespace}`).slice(0, 32)}-v1`;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const insertedMap = await client.query(`INSERT INTO source.field_mapping
        (mapping_revision, provider, namespace, root_grain, field_count)
        VALUES ($1,$2,$3,'recipe',2) ON CONFLICT DO NOTHING`,
      [mapping, observation.provider, observation.namespace]);
      if (insertedMap.rowCount === 1) {
        for (const [field, slot] of Object.entries(SLOT)) {
          await client.query(`INSERT INTO source.field_disposition
            (mapping_revision, grain, field_key, disposition, value_kind, reason, native_target)
            VALUES ($1,'recipe',$2,'native','text',$3,$4)`,
          [mapping, field, 'Exact retained text supports a human-confirmed Recipe occurrence', slot]);
        }
      }
      const registered = (await client.query<{ provider: string; namespace: string; field_count: number }>(
        'SELECT provider, namespace, field_count FROM source.field_mapping WHERE mapping_revision = $1',
        [mapping])).rows[0];
      if (!registered || registered.provider !== observation.provider
        || registered.namespace !== observation.namespace || registered.field_count !== 2) {
        throw new RecipeSourceConversionUnavailable('Recipe field mapping differs');
      }
      const inserted = await client.query(`INSERT INTO source.conversion
        (id,observation_id,principal_id,mapping_revision,source_digest,projection,field_inventory)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (observation_id,mapping_revision) DO NOTHING`,
      [Bun.randomUUIDv7(), observationId, principalId, mapping, observation.byteDigest,
        JSON.stringify(projected.projection), JSON.stringify(projected.inventory)]);
      const row = (await client.query<ConversionRow>(`SELECT id, source_digest, projection, field_inventory
        FROM source.conversion WHERE observation_id = $1 AND mapping_revision = $2 AND principal_id = $3`,
      [observationId, mapping, principalId])).rows[0];
      if (!row || row.source_digest !== observation.byteDigest
        || !isDeepStrictEqual(row.projection, projected.projection)
        || !isDeepStrictEqual(row.field_inventory, projected.inventory)) {
        throw new RecipeSourceConversionUnavailable('Recipe conversion differs from retained source');
      }
      await client.query('COMMIT');
      return { conversion: iri(row.id), observation: observation.observation,
        record: observation.record, mappingRevision: mapping,
        sourceDigest: row.source_digest, replayed: inserted.rowCount === 0 };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  private project(observation: StagedSourceObservation): { projection: object;
    inventory: Array<{ grain: 'recipe'; field: string; disposition: 'native' | 'unsupported';
      reason?: 'undeclared-field' }> } {
    if (observation.retention !== 'retained' || !observation.rawBytesBase64
      || !observation.byteDigest || observation.coverage.scope !== 'complete-recipe'
      || !observation.coverage.complete
      || !/^application\/(?:json|ld\+json)(?:;|$)/i.test(observation.mediaType)) {
      throw new RecipeSourceConversionInvalid('complete retained JSON Recipe source is required');
    }
    const bytes = Buffer.from(observation.rawBytesBase64, 'base64');
    if (digest(bytes) !== observation.byteDigest) {
      throw new RecipeSourceConversionUnavailable('Recipe source bytes differ from observation');
    }
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new RecipeSourceConversionInvalid('Recipe source is not JSON'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new RecipeSourceConversionInvalid('Recipe source is not an object');
    }
    const keys = Object.keys(value);
    if (keys.length > 128 || keys.some(key => !key || key.length > 200)) {
      throw new RecipeSourceConversionInvalid('Recipe field inventory exceeds its bound');
    }
    return { projection: { profile: 'recipe-source-conversion-v1' },
      inventory: keys.sort().map(field => field in SLOT
        ? { grain: 'recipe', field, disposition: 'native' }
        : { grain: 'recipe', field, disposition: 'unsupported', reason: 'undeclared-field' }) };
  }
}
