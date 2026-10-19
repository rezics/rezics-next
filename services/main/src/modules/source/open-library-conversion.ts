import type { VerifiedCreditOccurrence } from './credit-evidence.ts';
import { contentConnection, contentSessionClient } from '../../../../content/src/connection.ts';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { SourceIntakeStore, StagedSourceObservation } from './intake.ts';
import { mappedNativeDisposition } from './mapped-values.ts';
import { projectRegisteredSourceMapping } from './provider-adapters.ts';
import type { MappedSourceConversion, MappedSourceValues, VerifiedMappedSource } from './mapped-values.ts';
import { SourceRetainedRecordStore } from './retained-record.ts';

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

export interface OpenLibraryConversionDrift {
  profile: 'open-library-work-source-drift-v1' | 'source-mapped-drift-v1';
  state: 'staged';
  record: string;
  baseConversion: string;
  candidateConversion: string;
  baseObservation: string;
  candidateObservation: string;
  baseSourceRevision: string | null;
  candidateSourceRevision: string | null;
  representationChanged: boolean;
  fields: Array<{ field: string; status: 'added' | 'removed' | 'changed' | 'unchanged';
    baseDisposition: string | null; candidateDisposition: string | null }>;
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

/** The provider adapter translates its own shape; shared owners see only slots and occurrences. */
export function mappedOpenLibraryWork(projection: OpenLibraryWorkProjection): MappedSourceValues {
  return { title: { grain: 'work', field: 'title', pointer: '/title',
    slot: 'work-metadata-v1#title:en', value: projection.title },
  semanticTypes: ['https://schema.org/Book'],
  fields: projection.description === null ? [] : [{ grain: 'work', field: 'description',
    pointer: '/description', slot: 'work-editorial-field-v1#synopsis', value: projection.description }],
  children: [{ field: 'authors', grain: 'work', slot: null,
    values: projection.authorRefs?.map((ref, ordinal) => ({ ...ref, pointer: `/authors/${ordinal}`,
      value: ref.sourceKey })) ?? null },
  { field: 'subjects', grain: 'work', slot: 'work-native-child-v1#subjects',
    values: projection.subjects?.map((sourceKey, ordinal) => ({ sourceKey, roleKey: null,
      pointer: `/subjects/${ordinal}`, value: sourceKey })) ?? null }],
  sourceOnlyFields: ['description', 'authors', 'subjects'] };
}

interface StoredConversionRow {
  id: string; observation_id: string; mapping_revision: string;
  source_digest: string; projection: unknown; field_inventory: unknown; created_at: Date;
}
interface ConversionRow extends StoredConversionRow {
  mapping_revision: typeof OPEN_LIBRARY_WORK_MAPPING; projection: OpenLibraryWorkProjection;
  field_inventory: OpenLibraryFieldInventory[];
}

function result(row: ConversionRow): OpenLibraryConversion {
  return { profile: 'open-library-work-source-conversion-v1', state: 'staged',
    conversion: `https://rezics.com/id/${row.id}`,
    observation: `https://rezics.com/id/${row.observation_id}`,
    mappingRevision: row.mapping_revision, sourceDigest: row.source_digest,
    projection: row.projection, fieldInventory: row.field_inventory,
    createdAt: row.created_at.toISOString() };
}

function stable(value: unknown, depth = 0): string {
  if (depth > 128) throw new SourceConversionInvalid('source comparison exceeds nesting limit');
  if (Array.isArray(value)) return `[${value.map(item => stable(item, depth + 1)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item, depth + 1)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** An immutable explicit conversion already binds its output to these bytes.
 * Native consumers revalidate custody/integrity, never rerun its converter. */
function verifyConversionBytes(observation: StagedSourceObservation, digest: string): void {
  if (observation.retention !== 'retained' || !observation.rawBytesBase64
    || observation.byteDigest !== digest) throw new SourceConversionUnavailable('source conversion lost retained bytes');
  const bytes = Buffer.from(observation.rawBytesBase64,'base64');
  if (bytes.toString('base64') !== observation.rawBytesBase64 || bytes.length !== observation.byteLength
    || createHash('sha256').update(bytes).digest('hex') !== digest) {
    throw new SourceConversionUnavailable('source conversion differs from retained observation');
  }
}

export class OpenLibraryConversionStore {
  constructor(private readonly pool: Pool, private readonly intake: SourceIntakeStore) {}

  /** The retained profile uses this conversion owner, with its own verified coordinate system. */
  get retained(): SourceRetainedRecordStore { return new SourceRetainedRecordStore(this.pool, this.intake); }

  /** Shared evidence boundary. Legacy projection bytes remain unchanged for exact receipts. */
  async mappedRead(principalId: string, conversionId: string): Promise<VerifiedMappedSource | null> {
    if (!UUID.test(principalId) || !UUID.test(conversionId)) {
      throw new SourceConversionInvalid('invalid source conversion identity');
    }
    const row = (await contentConnection(this.pool).query<StoredConversionRow>(`SELECT * FROM source.conversion
      WHERE id = $1 AND principal_id = $2`, [conversionId, principalId])).rows[0];
    if (!row) return null;
    if (row.mapping_revision === OPEN_LIBRARY_WORK_MAPPING) {
      const evidence = await this.verifiedRead(principalId, conversionId);
      if (!evidence) return null;
      const values = mappedOpenLibraryWork(evidence.conversion.projection);
      return { observation: evidence.observation, values, legacy: evidence.conversion, conversion: {
        ...evidence.conversion, profile: 'source-mapped-conversion-v1', projection: values,
        fieldInventory: evidence.conversion.fieldInventory.map(field => ({ ...field, grain: 'work' })) } };
    }
    const observation = await this.intake.read(principalId, row.observation_id);
    if (!observation) throw new SourceConversionUnavailable('source conversion lost its observation');
    verifyConversionBytes(observation,row.source_digest);
    const projected = await this.validateMapped(observation,row.mapping_revision,{
      values: row.projection as MappedSourceValues,
      inventory: row.field_inventory as MappedSourceConversion['fieldInventory'],
    });
    const conversion: MappedSourceConversion = { profile: 'source-mapped-conversion-v1', state: 'staged',
      conversion: `https://rezics.com/id/${row.id}`, observation: observation.observation,
      mappingRevision: row.mapping_revision, sourceDigest: row.source_digest,
      projection: projected.values, fieldInventory: projected.inventory, createdAt: row.created_at.toISOString() };
    return { conversion, observation, values: projected.values };
  }

  private async projectMapped(observation: StagedSourceObservation, mapping: string) {
    return this.validateMapped(observation,mapping,projectRegisteredSourceMapping(observation,mapping));
  }

  private async validateMapped(observation: StagedSourceObservation, mapping: string,
    projected: { values: MappedSourceValues; inventory: MappedSourceConversion['fieldInventory'] }) {
    const declarations = (await contentConnection(this.pool).query<{ provider: string; namespace: string;
      grain: string; field_key: string; disposition: string; native_target: string | null }>(`
      SELECT m.provider,m.namespace,d.grain,d.field_key,d.disposition,d.native_target
      FROM source.field_mapping m JOIN source.field_disposition d USING (mapping_revision)
      WHERE m.mapping_revision = $1 LIMIT 1025`, [mapping])).rows;
    if (!declarations.length || declarations.length > 1024 || declarations.some(row =>
      row.provider !== observation.provider || row.namespace !== observation.namespace)) {
      throw new SourceConversionUnavailable('mapping identity differs from observation');
    }
    for (const field of projected.inventory) {
      const declared = declarations.find(row => row.grain === field.grain && row.field_key === field.field);
      if (field.disposition !== (declared?.disposition ?? 'unsupported')) {
        throw new SourceConversionUnavailable('field inventory differs from sealed mapping');
      }
    }
    for (const field of [projected.values.title, ...projected.values.fields,
      ...projected.values.children.filter(child => child.slot !== null)]) {
      if (!declarations.some(row => row.grain === field.grain && row.field_key === field.field
        && mappedNativeDisposition(row, field.slot))) {
        throw new SourceConversionUnavailable('mapped native slot differs from sealed mapping');
      }
    }
    return projected;
  }

  async convertMapped(principalId: string, observationId: string, mapping: string):
    Promise<{ conversion: MappedSourceConversion; replayed: boolean } | null> {
    if (!UUID.test(principalId) || !UUID.test(observationId)) {
      throw new SourceConversionInvalid('invalid source conversion identity');
    }
    if (mapping === OPEN_LIBRARY_WORK_MAPPING) {
      const result = await this.convert(principalId, observationId);
      if (!result) return null;
      return { conversion: (await this.mappedRead(principalId, result.conversion.conversion.slice(-36)))!.conversion,
        replayed: result.replayed };
    }
    const observation = await this.intake.read(principalId, observationId);
    if (!observation) return null;
    const projected = await this.projectMapped(observation, mapping);
    const inserted = await contentConnection(this.pool).query(`INSERT INTO source.conversion
      (id,observation_id,principal_id,mapping_revision,source_digest,projection,field_inventory)
      VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (observation_id,mapping_revision) DO NOTHING`,
    [Bun.randomUUIDv7(), observationId, principalId, mapping, observation.byteDigest,
      JSON.stringify(projected.values), JSON.stringify(projected.inventory)]);
    const row = (await contentConnection(this.pool).query<{ id: string }>(`SELECT id FROM source.conversion
      WHERE observation_id=$1 AND mapping_revision=$2 AND principal_id=$3`,
    [observationId, mapping, principalId])).rows[0];
    if (!row) throw new SourceConversionUnavailable('source conversion is unavailable');
    return { conversion: (await this.mappedRead(principalId, row.id))!.conversion,
      replayed: inserted.rowCount === 0 };
  }

  async convert(principalId: string, observationId: string):
    Promise<{ conversion: OpenLibraryConversion; replayed: boolean } | null> {
    if (!UUID.test(principalId) || !UUID.test(observationId)) {
      throw new SourceConversionInvalid('invalid source conversion identity');
    }
    const observation = await this.intake.read(principalId, observationId);
    if (!observation) return null;
    const projected = projectOpenLibraryWork(observation);
    const borrowed = contentSessionClient(this.pool);
    const client = borrowed ?? await this.pool.connect();
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
    } finally { if (!borrowed) client.release(); }
  }

  async read(principalId: string, conversionId: string): Promise<OpenLibraryConversion | null> {
    if (!UUID.test(principalId) || !UUID.test(conversionId)) {
      throw new SourceConversionInvalid('invalid source conversion identity');
    }
    const rows = await contentConnection(this.pool).query<ConversionRow>(`SELECT id, observation_id, mapping_revision,
      source_digest, projection, field_inventory, created_at FROM source.conversion
      WHERE id = $1 AND principal_id = $2`, [conversionId, principalId]);
    return rows.rows[0] ? result(rows.rows[0]) : null;
  }

  async verifiedRead(principalId: string, conversionId: string): Promise<{
    conversion: OpenLibraryConversion; observation: StagedSourceObservation; credits: VerifiedCreditOccurrence[] | null } | null> {
    const conversion = await this.read(principalId, conversionId);
    if (!conversion) return null;
    const observation = await this.intake.read(principalId,
      conversion.observation.split('/').at(-1)!);
    if (!observation) throw new SourceConversionUnavailable('source conversion lost its observation');
    verifyConversionBytes(observation,conversion.sourceDigest);
    if (conversion.mappingRevision !== OPEN_LIBRARY_WORK_MAPPING
      || observation.profile !== 'source-acquisition-v1'
      || observation.capture?.profile !== 'open-library-work-acquisition-v1'
      || observation.provider !== 'open-library' || observation.namespace !== 'work'
      || observation.coverage.scope !== 'open-library-work-response-v1'
      || !observation.coverage.complete) throw new SourceConversionUnavailable('source conversion basis differs');
    return { conversion, observation, credits: conversion.projection.authorRefs?.map(ref => ({ ...ref,
      provider: 'open-library', namespace: 'author', role: 'author' as const })) ?? null };
  }

  async compare(principalId: string, baseId: string, candidateId: string):
    Promise<OpenLibraryConversionDrift | null> {
    if (!UUID.test(principalId) || !UUID.test(baseId) || !UUID.test(candidateId)) {
      throw new SourceConversionInvalid('invalid source conversion identity');
    }
    const [baseEvidence, candidateEvidence] = await Promise.all([
      this.mappedRead(principalId, baseId), this.mappedRead(principalId, candidateId),
    ]);
    if (!baseEvidence || !candidateEvidence) return null;
    const { observation: baseObservation } = baseEvidence;
    const base = baseEvidence.legacy ?? baseEvidence.conversion;
    const { observation: candidateObservation } = candidateEvidence;
    const candidate = candidateEvidence.legacy ?? candidateEvidence.conversion;
    if (baseObservation.record !== candidateObservation.record) {
      throw new SourceConversionInvalid('source conversions have different record identities');
    }
    const bodies = [baseObservation, candidateObservation].map(observation =>
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
        Buffer.from(observation.rawBytesBase64!, 'base64'))) as Record<string, unknown>);
    const values = bodies.map(body => new Map(Object.entries(body)
      .map(([field, value]) => [field, stable(value)])));
    const baseInventory = new Map(base.fieldInventory.map(item => [item.field, item.disposition]));
    const candidateInventory = new Map(candidate.fieldInventory.map(item => [item.field, item.disposition]));
    const fields = [...new Set([...baseInventory.keys(), ...candidateInventory.keys()])]
      .sort().map(field => {
        const baseDisposition = baseInventory.get(field) ?? null;
        const candidateDisposition = candidateInventory.get(field) ?? null;
        const status: OpenLibraryConversionDrift['fields'][number]['status'] =
          baseDisposition === null ? 'added'
          : candidateDisposition === null ? 'removed'
          : values[0]!.get(field) !== values[1]!.get(field)
            || baseDisposition !== candidateDisposition ? 'changed' : 'unchanged';
        return { field, status, baseDisposition, candidateDisposition };
      });
    return { profile: baseEvidence.legacy && candidateEvidence.legacy
      ? 'open-library-work-source-drift-v1' : 'source-mapped-drift-v1', state: 'staged',
      record: baseObservation.record, baseConversion: base.conversion,
      candidateConversion: candidate.conversion, baseObservation: base.observation,
      candidateObservation: candidate.observation,
      baseSourceRevision: baseObservation.sourceRevision,
      candidateSourceRevision: candidateObservation.sourceRevision,
      representationChanged: base.sourceDigest !== candidate.sourceDigest, fields };
  }
}
