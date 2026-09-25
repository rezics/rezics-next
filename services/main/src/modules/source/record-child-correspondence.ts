import type { Pool } from 'pg';
import { compareSourceChildren, type SourceChildCorrespondence,
  type SourceChildOccurrence } from './child-correspondence.ts';
import type { OpenLibraryConversionStore } from './open-library-conversion.ts';

export class SourceChildCorrespondenceInvalid extends Error {}
export class SourceChildCorrespondenceConflict extends Error {}
export class SourceChildCorrespondenceUnavailable extends Error {}

export interface RecordedSourceChildCorrespondence {
  profile: 'source-child-correspondence-v1';
  state: 'recorded';
  correspondence: string;
  record: string;
  baseConversion: string;
  candidateConversion: string;
  field: 'authors' | 'subjects';
  baseOccurrence: string;
  candidateOccurrence: string;
  baseOrdinal: number;
  candidateOrdinal: number;
  sourceKey: string;
  createdAt: string;
}

interface Row {
  id: string; principal_id: string; record_id: string;
  base_conversion_id: string; candidate_conversion_id: string;
  field: 'authors' | 'subjects'; base_occurrence: string;
  candidate_occurrence: string; base_ordinal: number; candidate_ordinal: number;
  source_key: string; idempotency_key: string; created_at: Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OCCURRENCE = /^urn:rezics:source-occurrence:[0-9a-f]{64}$/;
const KEY = /^[A-Za-z0-9:_./-]{1,128}$/;
const url = (id: string): string => `https://rezics.com/id/${id}`;
const id = (uri: string): string => uri.split('/').at(-1)!;

function selectedPair(comparison: SourceChildCorrespondence,
  field: 'authors' | 'subjects', baseOccurrence: string, candidateOccurrence: string):
  { base: SourceChildOccurrence; candidate: SourceChildOccurrence } {
  const children = comparison.fields.find(item => item.field === field);
  const base = children?.base.find(item => item.occurrence === baseOccurrence);
  const candidate = children?.candidate.find(item => item.occurrence === candidateOccurrence);
  if (children?.coverage !== 'complete' || !base || !candidate
    || base.status !== 'ambiguous' || candidate.status !== 'ambiguous'
    || base.sourceKey !== candidate.sourceKey) {
    throw new SourceChildCorrespondenceConflict('child occurrences cannot be safely paired');
  }
  return { base, candidate };
}

function result(row: Row): RecordedSourceChildCorrespondence {
  return { profile: 'source-child-correspondence-v1', state: 'recorded',
    correspondence: url(row.id), record: url(row.record_id),
    baseConversion: url(row.base_conversion_id),
    candidateConversion: url(row.candidate_conversion_id), field: row.field,
    baseOccurrence: row.base_occurrence,
    candidateOccurrence: row.candidate_occurrence,
    baseOrdinal: row.base_ordinal, candidateOrdinal: row.candidate_ordinal,
    sourceKey: row.source_key, createdAt: row.created_at.toISOString() };
}

export class SourceChildCorrespondenceStore {
  constructor(private readonly pool: Pool,
    private readonly conversions: OpenLibraryConversionStore) {}

  private async verified(row: Row): Promise<RecordedSourceChildCorrespondence> {
    const comparison = await compareSourceChildren(this.conversions, row.principal_id,
      row.base_conversion_id, row.candidate_conversion_id);
    if (!comparison || comparison.record !== url(row.record_id)) {
      throw new SourceChildCorrespondenceUnavailable('source child evidence is unavailable');
    }
    let pair: ReturnType<typeof selectedPair>;
    try { pair = selectedPair(comparison, row.field, row.base_occurrence,
      row.candidate_occurrence); }
    catch (error) {
      if (!(error instanceof SourceChildCorrespondenceConflict)) throw error;
      throw new SourceChildCorrespondenceUnavailable('recorded child pair lost its evidence');
    }
    if (pair.base.ordinal !== row.base_ordinal
      || pair.candidate.ordinal !== row.candidate_ordinal
      || pair.base.sourceKey !== row.source_key) {
      throw new SourceChildCorrespondenceUnavailable('source child decision differs from evidence');
    }
    return result(row);
  }

  async record(principalId: string, key: string, input: {
    baseConversion: string; candidateConversion: string;
    field: 'authors' | 'subjects'; baseOccurrence: string;
    candidateOccurrence: string }):
    Promise<{ correspondence: RecordedSourceChildCorrespondence; replayed: boolean } | null> {
    if (!UUID.test(principalId) || !UUID.test(input.baseConversion)
      || !UUID.test(input.candidateConversion) || !KEY.test(key)
      || input.baseConversion === input.candidateConversion
      || !['authors', 'subjects'].includes(input.field)
      || !OCCURRENCE.test(input.baseOccurrence)
      || !OCCURRENCE.test(input.candidateOccurrence)) {
      throw new SourceChildCorrespondenceInvalid('invalid child correspondence request');
    }
    const comparison = await compareSourceChildren(this.conversions, principalId,
      input.baseConversion, input.candidateConversion);
    if (!comparison) return null;
    const pair = selectedPair(comparison, input.field, input.baseOccurrence,
      input.candidateOccurrence);
    const inserted = await this.pool.query(`INSERT INTO source.child_correspondence
      (id, principal_id, record_id, base_conversion_id, candidate_conversion_id,
       field, base_occurrence, candidate_occurrence, base_ordinal, candidate_ordinal,
       source_key, idempotency_key)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT DO NOTHING`,
    [Bun.randomUUIDv7(), principalId, id(comparison.record), input.baseConversion,
      input.candidateConversion, input.field, input.baseOccurrence,
      input.candidateOccurrence, pair.base.ordinal, pair.candidate.ordinal,
      pair.base.sourceKey, key]);
    const row = (await this.pool.query<Row>(`SELECT * FROM source.child_correspondence
      WHERE principal_id = $1 AND idempotency_key = $2`, [principalId, key])).rows[0];
    if (!row || row.base_conversion_id !== input.baseConversion
      || row.candidate_conversion_id !== input.candidateConversion
      || row.field !== input.field || row.base_occurrence !== input.baseOccurrence
      || row.candidate_occurrence !== input.candidateOccurrence
      || row.base_ordinal !== pair.base.ordinal
      || row.candidate_ordinal !== pair.candidate.ordinal
      || row.source_key !== pair.base.sourceKey) {
      throw new SourceChildCorrespondenceConflict('child correspondence key or occurrence conflicts');
    }
    return { correspondence: await this.verified(row), replayed: inserted.rowCount === 0 };
  }

  async read(principalId: string, correspondenceId: string):
    Promise<RecordedSourceChildCorrespondence | null> {
    if (!UUID.test(principalId) || !UUID.test(correspondenceId)) {
      throw new SourceChildCorrespondenceInvalid('invalid child correspondence identity');
    }
    const row = (await this.pool.query<Row>(`SELECT * FROM source.child_correspondence
      WHERE id = $1 AND principal_id = $2`, [correspondenceId, principalId])).rows[0];
    return row ? this.verified(row) : null;
  }
}
