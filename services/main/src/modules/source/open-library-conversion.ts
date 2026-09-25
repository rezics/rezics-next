import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { SourceIntakeStore, StagedSourceObservation } from './intake.ts';

export class SourceConversionInvalid extends Error {}
export class SourceConversionUnavailable extends Error {}

export const OPEN_LIBRARY_WORK_MAPPING = 'open-library-work-map-v1';

type Disposition = 'source-identity' | 'candidate-fact' | 'source-expression'
  | 'source-reference' | 'source-terms' | 'source-metadata'
  | 'retained-only' | 'unmapped-retained';

export interface OpenLibraryFieldInventory {
  field: string;
  disposition: Disposition;
}

export interface OpenLibraryWorkProjection {
  sourceKey: string;
  title: string;
  description: string | null;
  authorRefs: Array<{ sourceKey: string; roleKey: string | null }> | null;
  subjects: string[] | null;
}

export interface OpenLibraryConversion {
  profile: 'open-library-work-source-conversion-v1';
  state: 'staged';
  conversion: string;
  observation: string;
  mappingRevision: typeof OPEN_LIBRARY_WORK_MAPPING;
  sourceDigest: string;
  projection: OpenLibraryWorkProjection;
  fieldInventory: OpenLibraryFieldInventory[];
  createdAt: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const AUTHOR_KEY = /^\/authors\/OL[1-9][0-9]{0,11}A$/;
const META = new Set(['type', 'revision', 'latest_revision', 'created', 'last_modified']);
const RETAINED = new Set(['covers', 'subject_places', 'subject_people',
  'subject_times', 'genres', 'location']);

function authorRefs(value: unknown): OpenLibraryWorkProjection['authorRefs'] {
  if (!Array.isArray(value) || value.length > 128) return null;
  const refs: NonNullable<OpenLibraryWorkProjection['authorRefs']> = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const author = (item as { author?: unknown }).author;
    const type = (item as { type?: unknown }).type;
    if (!author || typeof author !== 'object' || Array.isArray(author)
      || !AUTHOR_KEY.test((author as { key?: string }).key ?? '')) return null;
    const roleKey = type && typeof type === 'object' && !Array.isArray(type)
      && typeof (type as { key?: unknown }).key === 'string'
      ? (type as { key: string }).key : null;
    refs.push({ sourceKey: (author as { key: string }).key, roleKey });
  }
  return refs;
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 256
    || value.some(item => typeof item !== 'string' || item.length > 200)) return null;
  return value;
}

function descriptionText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as { value?: unknown }).value === 'string') {
    return (value as { value: string }).value;
  }
  return null;
}

export function projectOpenLibraryWork(observation: StagedSourceObservation):
  Pick<OpenLibraryConversion, 'sourceDigest' | 'projection' | 'fieldInventory'> {
  if (observation.profile !== 'source-acquisition-v1'
    || observation.capture?.profile !== 'open-library-work-acquisition-v1'
    || observation.provider !== 'open-library' || observation.namespace !== 'work'
    || observation.retention !== 'retained' || !observation.rawBytesBase64
    || !observation.byteDigest || observation.coverage.scope !== 'open-library-work-response-v1'
    || !observation.coverage.complete) {
    throw new SourceConversionInvalid('source capture is incomplete or has the wrong profile');
  }
  const raw = Buffer.from(observation.rawBytesBase64, 'base64');
  if (createHash('sha256').update(raw).digest('hex') !== observation.byteDigest) {
    throw new SourceConversionUnavailable('source capture digest differs');
  }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
  catch { throw new SourceConversionInvalid('source capture is malformed JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SourceConversionInvalid('source capture is not a Work object');
  }
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body);
  if (keys.length > 128 || keys.some(key => !key || key.length > 100)) {
    throw new SourceConversionInvalid('source field inventory exceeds the profile');
  }
  if (body.key !== `/works/${observation.externalId}`
    || typeof body.title !== 'string' || !body.title || body.title.length > 500
    || !body.type || typeof body.type !== 'object' || Array.isArray(body.type)
    || (body.type as { key?: unknown }).key !== '/type/work') {
    throw new SourceConversionInvalid('source capture has the wrong Work grain');
  }
  const authors = body.authors === undefined ? null : authorRefs(body.authors);
  const subjects = body.subjects === undefined ? null : stringList(body.subjects);
  const description = body.description === undefined ? null : descriptionText(body.description);
  const fieldInventory: OpenLibraryFieldInventory[] = keys.sort().map(field => {
    let disposition: Disposition;
    if (field === 'key') disposition = 'source-identity';
    else if (field === 'title') disposition = 'candidate-fact';
    else if (field === 'description') disposition = description !== null
      ? 'source-expression' : 'unmapped-retained';
    else if (field === 'authors') disposition = authors !== null
      ? 'source-reference' : 'unmapped-retained';
    else if (field === 'subjects') disposition = subjects !== null
      ? 'source-terms' : 'unmapped-retained';
    else if (META.has(field)) disposition = 'source-metadata';
    else disposition = RETAINED.has(field) ? 'retained-only' : 'unmapped-retained';
    return { field, disposition };
  });
  return { sourceDigest: observation.byteDigest,
    projection: { sourceKey: body.key as string, title: body.title,
      description, authorRefs: authors, subjects }, fieldInventory };
}

interface ConversionRow {
  id: string; observation_id: string; mapping_revision: typeof OPEN_LIBRARY_WORK_MAPPING;
  source_digest: string; projection: OpenLibraryWorkProjection;
  field_inventory: OpenLibraryFieldInventory[]; created_at: Date;
}

function result(row: ConversionRow): OpenLibraryConversion {
  return { profile: 'open-library-work-source-conversion-v1', state: 'staged',
    conversion: `https://rezics.com/id/${row.id}`,
    observation: `https://rezics.com/id/${row.observation_id}`,
    mappingRevision: row.mapping_revision, sourceDigest: row.source_digest,
    projection: row.projection, fieldInventory: row.field_inventory,
    createdAt: row.created_at.toISOString() };
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export class OpenLibraryConversionStore {
  constructor(private readonly pool: Pool, private readonly intake: SourceIntakeStore) {}

  async convert(principalId: string, observationId: string):
    Promise<{ conversion: OpenLibraryConversion; replayed: boolean } | null> {
    if (!UUID.test(principalId) || !UUID.test(observationId)) {
      throw new SourceConversionInvalid('invalid source conversion identity');
    }
    const observation = await this.intake.read(principalId, observationId);
    if (!observation) return null;
    const projected = projectOpenLibraryWork(observation);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const inserted = await client.query<{ id: string }>(`INSERT INTO source.conversion
        (id, observation_id, principal_id, mapping_revision, source_digest,
         projection, field_inventory)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (observation_id, mapping_revision) DO NOTHING RETURNING id`,
      [Bun.randomUUIDv7(), observationId, principalId, OPEN_LIBRARY_WORK_MAPPING,
        projected.sourceDigest, JSON.stringify(projected.projection),
        JSON.stringify(projected.fieldInventory)]);
      const rows = await client.query<ConversionRow>(`SELECT id, observation_id, mapping_revision,
        source_digest, projection, field_inventory, created_at FROM source.conversion
        WHERE observation_id = $1 AND mapping_revision = $2 AND principal_id = $3`,
      [observationId, OPEN_LIBRARY_WORK_MAPPING, principalId]);
      const row = rows.rows[0];
      if (!row || row.source_digest !== projected.sourceDigest
        || stable(row.projection) !== stable(projected.projection)
        || stable(row.field_inventory) !== stable(projected.fieldInventory)) {
        throw new SourceConversionUnavailable('source mapping revision differs from retained conversion');
      }
      await client.query('COMMIT');
      return { conversion: result(row), replayed: inserted.rowCount === 0 };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async read(principalId: string, conversionId: string): Promise<OpenLibraryConversion | null> {
    if (!UUID.test(principalId) || !UUID.test(conversionId)) {
      throw new SourceConversionInvalid('invalid source conversion identity');
    }
    const rows = await this.pool.query<ConversionRow>(`SELECT id, observation_id, mapping_revision,
      source_digest, projection, field_inventory, created_at FROM source.conversion
      WHERE id = $1 AND principal_id = $2`, [conversionId, principalId]);
    return rows.rows[0] ? result(rows.rows[0]) : null;
  }
}
