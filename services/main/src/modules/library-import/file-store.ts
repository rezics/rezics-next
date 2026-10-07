import { Value } from 'typebox/value';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { FILE_IMPORT_COST, canonicalRow, type CanonicalRow, type LibraryFileFormat } from './formats/contract.ts';
import { ReaderImportConflict } from './reader-import.ts';
import { deleteLibraryUploads } from './privacy.ts';
import { LibraryImportJobStore, ImportJobLeaseLost } from './job-store.ts';

export class LibraryFileMissing extends Error {}
export const LIBRARY_UPLOAD_RETENTION_DAYS = 7;

export interface ImportCandidate { work: string; target: string | null; title: string; creators: string[] }
export interface RowMatch { kind: 'matched' | 'ambiguous' | 'not-found'; candidates: ImportCandidate[];
  work: string | null; target: string | null; truncated: boolean;
  openLibraryAvailability: 'available' | 'budget-exceeded' | 'unavailable' | 'not-requested';
  openLibrary: Array<{ workId: string; title: string; authors: string[]; coverId: number | null }> }
export interface RowResolution { choice: 'apply' | 'private'; work?: string; target?: string;
  conflictChoice?: 'keep' | 'replace' }
export interface StoredSourceRow { index: number; source: CanonicalRow; match: RowMatch | null;
  resolution: RowResolution | null; outcome: { applied: string[]; issues: string[] } | null; version: number }
export interface ApplyIntent { context: string | null; language: string }
interface SourceRecord { row_number: number; source: CanonicalRow; match: RowMatch | null;
  resolution: RowResolution | null; outcome: StoredSourceRow['outcome']; version: string }
const unpack = (row: SourceRecord): StoredSourceRow => ({ index: row.row_number, source: row.source,
  match: row.match, resolution: row.resolution, outcome: row.outcome, version: Number(row.version) });
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => [k,stable(v)])) : value;
export const importDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
export const fileIdentity = (agent: string, key: string) => {
  const h = importDigest([agent, key]);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

// A portable source envelope is a view of the original evidence, not a
// second copy of its bytes. Validate its digest before sharing the owner row.
export function storedImportSource(row: CanonicalRow) {
  const original = row.kind==='retained' && /^source:[0-9a-f]{64}$/.test(row.sourceId) ? row.raw.source : null;
  if (original && Value.Check(canonicalRow,original) && original.kind!=='retained'
    && row.sourceId===`source:${importDigest(original)}`) {
    const { source: _source,...raw } = row.raw;
    return { digest: importDigest(original),source: original,view: { ...row,raw } };
  }
  return { digest: importDigest(row),source: row,view: undefined };
}
const sourceView = `CASE WHEN r.source_view IS NULL THEN s.source ELSE r.source_view ||
  jsonb_build_object('raw',r.source_view->'raw' || jsonb_build_object('source',s.source)) END AS source`;

/** One bulk insert; pages and apply use the (agent,file,row) keyset. All review
 * mutations lock the file before rows, so apply seals one immutable intent. */
export class LibraryFileStore {
  readonly jobs: LibraryImportJobStore;
  constructor(readonly pool: Pool) { this.jobs=new LibraryImportJobStore(pool); }
  async create(agent: string, key: string, digest: string, format: LibraryFileFormat, rows: CanonicalRow[]) {
    const id = fileIdentity(agent, key), client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['library-upload',agent])]);
      const receipt = (await client.query<{ request_digest: string; file_id: string | null }>(`
        SELECT request_digest,file_id FROM reader.library_import_upload_command WHERE agent=$1 AND idempotency_key=$2`,[agent,key])).rows[0];
      if (receipt && receipt.request_digest !== digest) throw new ReaderImportConflict('Import key belongs to another file or mapping');
      if (receipt && !receipt.file_id) throw new LibraryFileMissing('Upload was deleted or expired; use a new Idempotency-Key');
      const previous = (await client.query<{ id: string; expires_at: Date }>(`
        SELECT id,expires_at FROM reader.library_import_file WHERE agent=$1 AND file_digest=$2`,[agent,digest])).rows[0];
      if (previous && previous.expires_at.getTime() <= Date.now()) throw new LibraryFileMissing('Upload expired; its private fields are being deleted');
      if (previous) {
        await client.query(`INSERT INTO reader.library_import_upload_command(agent,idempotency_key,request_digest,file_id)
          VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[agent,key,digest,previous.id]);
        await client.query('COMMIT');return { id: previous.id,total: rows.length };
      }
      await client.query(`INSERT INTO reader.library_import_batch(agent,import_key,request_digest,row_count)
        VALUES ($1,$2,$3,$4) ON CONFLICT (agent,import_key) DO NOTHING`, [agent,key,digest,rows.length]);
      const prior = await client.query<{ request_digest: string }>(`SELECT request_digest FROM reader.library_import_batch
        WHERE agent=$1 AND import_key=$2 FOR UPDATE`, [agent,key]);
      if (prior.rows[0]?.request_digest !== digest) throw new ReaderImportConflict('Import key belongs to another file or mapping');
      await client.query(`INSERT INTO reader.library_import_file(agent,id,import_key,format,file_digest)
        VALUES ($1,$2,$3,$4,$5)`, [agent,id,key,format,digest]);
      const sources = rows.map(storedImportSource);
      await client.query(`INSERT INTO reader.library_import_source(agent,digest,source)
        SELECT $1,value->>'digest',value->'source' FROM jsonb_array_elements($2::jsonb)
        ON CONFLICT DO NOTHING`,[agent,JSON.stringify(sources.map(({ digest,source }) => ({ digest,source })))]);
      await client.query(`INSERT INTO reader.library_import_source_row(agent,file_id,row_number,source_digest,source_view)
        SELECT $1,$2,(ordinal-1)::integer,value->>'digest',value->'view' FROM jsonb_array_elements($3::jsonb) WITH ORDINALITY AS r(value,ordinal)`,
      [agent,id,JSON.stringify(sources.map(({ digest,view }) => ({ digest,view })))]);
      await client.query(`INSERT INTO reader.library_import_upload_command(agent,idempotency_key,request_digest,file_id)
        VALUES ($1,$2,$3,$4)`,[agent,key,digest,id]);
      await client.query('COMMIT');
      return { id, total: rows.length };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async file(agent: string, id: string) {
    const result = await this.pool.query<{ import_key: string; format: LibraryFileFormat; apply_intent: ApplyIntent | null }>(`
      SELECT import_key,format,apply_intent FROM reader.library_import_file WHERE agent=$1 AND id=$2 AND expires_at>clock_timestamp()`, [agent,id]);
    if (!result.rows[0]) throw new LibraryFileMissing('Import file was deleted, expired or is unavailable');
    return result.rows[0];
  }
  async page(agent: string, id: string, after: number, limit = FILE_IMPORT_COST.page as number) {
    await this.file(agent,id);
    const result = await this.pool.query<SourceRecord>(`SELECT r.row_number,${sourceView},r.match,r.resolution,r.outcome,r.version::text
      FROM reader.library_import_source_row r JOIN reader.library_import_source s ON s.agent=r.agent AND s.digest=r.source_digest
      WHERE r.agent=$1 AND r.file_id=$2 AND r.row_number>$3 ORDER BY r.row_number LIMIT $4`, [agent,id,after,limit+1]);
    return { rows: result.rows.slice(0,limit).map(unpack), more: result.rows.length>limit };
  }
  async saveMatch(agent: string, id: string, index: number, match: RowMatch) {
    await this.pool.query(`UPDATE reader.library_import_source_row SET match=$4,version=version+1
      WHERE agent=$1 AND file_id=$2 AND row_number=$3 AND match IS NULL`, [agent,id,index,JSON.stringify(match)]);
  }
  async resolve(agent: string, id: string, index: number, version: number, resolution: RowResolution, key: string) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const digest = importDigest([id,index,version,resolution]);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['library-review',agent,key])]);
      const receipt = await client.query<{ request_digest: string }>(`SELECT request_digest FROM reader.library_import_review_command
        WHERE agent=$1 AND idempotency_key=$2`,[agent,key]);
      if (receipt.rows[0]) {
        if (receipt.rows[0].request_digest !== digest) throw new ReaderImportConflict('Review key belongs to another row choice');
        await client.query('COMMIT'); return;
      }
      const file = await client.query<{ apply_intent: unknown }>(`SELECT apply_intent FROM reader.library_import_file
        WHERE agent=$1 AND id=$2 AND expires_at>clock_timestamp() FOR UPDATE`, [agent,id]);
      if (!file.rows[0]) throw new LibraryFileMissing('Import file was deleted, expired or is unavailable');
      if (file.rows[0].apply_intent) throw new ReaderImportConflict('Application has started; row choices are sealed');
      const row = await client.query<SourceRecord>(`SELECT r.row_number,${sourceView},r.match,r.resolution,r.outcome,r.version::text
        FROM reader.library_import_source_row r JOIN reader.library_import_source s ON s.agent=r.agent AND s.digest=r.source_digest
        WHERE r.agent=$1 AND r.file_id=$2 AND r.row_number=$3 FOR UPDATE OF r`, [agent,id,index]);
      if (!row.rows[0]) throw new LibraryFileMissing('Import row is unavailable');
      const current = unpack(row.rows[0]);
      // Same intent is replayable even when the caller lost the first response.
      if (importDigest(current.resolution) !== importDigest(resolution)) {
        if (current.version !== version) throw new ReaderImportConflict('Import row changed; reload it before resolving');
        await client.query(`UPDATE reader.library_import_source_row SET resolution=$4,version=version+1
          WHERE agent=$1 AND file_id=$2 AND row_number=$3`, [agent,id,index,JSON.stringify(resolution)]);
      }
      await client.query(`INSERT INTO reader.library_import_review_command(agent,idempotency_key,request_digest) VALUES ($1,$2,$3)`,[agent,key,digest]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async seal(agent: string, id: string, intent: ApplyIntent) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const held = await client.query<{ apply_intent: ApplyIntent | null }>(`SELECT apply_intent FROM reader.library_import_file
        WHERE agent=$1 AND id=$2 AND expires_at>clock_timestamp() FOR UPDATE`, [agent,id]);
      if (!held.rows[0]) throw new LibraryFileMissing('Import file was deleted, expired or is unavailable');
      if (held.rows[0].apply_intent && importDigest(held.rows[0].apply_intent) !== importDigest(intent)) {
        throw new ReaderImportConflict('Apply context or language changed');
      }
      const unresolved = await client.query(`SELECT row_number FROM reader.library_import_source_row
        WHERE agent=$1 AND file_id=$2 AND resolution IS NULL
          AND (match IS NULL OR match->>'kind' != 'matched') LIMIT 1`, [agent,id]);
      if (unresolved.rowCount) throw new ReaderImportConflict('Review all rows and resolve or keep ambiguous and missing rows private');
      await client.query(`UPDATE reader.library_import_file SET apply_intent=$3 WHERE agent=$1 AND id=$2`, [agent,id,JSON.stringify(intent)]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async pending(agent: string, id: string) {
    const rows = await this.pool.query<SourceRecord>(`SELECT r.row_number,${sourceView},r.match,r.resolution,r.outcome,r.version::text
      FROM reader.library_import_source_row r JOIN reader.library_import_source s ON s.agent=r.agent AND s.digest=r.source_digest
      WHERE r.agent=$1 AND r.file_id=$2 AND r.outcome IS NULL ORDER BY r.row_number LIMIT ${FILE_IMPORT_COST.page}`, [agent,id]);
    return rows.rows.map(unpack);
  }
  async complete(agent: string, id: string, index: number, outcome: NonNullable<StoredSourceRow['outcome']>,token?: string) {
    const client=await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (token && !(await client.query(`SELECT 1 FROM reader.library_import_job WHERE agent=$1 AND file_id=$2
        AND state='pending' AND lease_token=$3 FOR UPDATE`,[agent,id,token])).rowCount) throw new ImportJobLeaseLost('Import worker lease expired');
      await client.query(`UPDATE reader.library_import_source_row SET outcome=$4,version=version+1
        WHERE agent=$1 AND file_id=$2 AND row_number=$3 AND outcome IS NULL`,[agent,id,index,JSON.stringify(outcome)]);
      if (token) await this.jobs.progress(agent,id,token,client);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK');throw error; } finally { client.release(); }
  }
  async progress(agent: string, id: string) {
    await this.file(agent,id);
    const job=await this.jobs.status(agent,id);
    const result = await this.pool.query<{ total: number; completed: number; issues: number }>(`SELECT count(*)::integer AS total,
      count(outcome)::integer AS completed,
      count(*) FILTER (WHERE jsonb_array_length(outcome->'issues')>0)::integer AS issues
      FROM reader.library_import_source_row WHERE agent=$1 AND file_id=$2`, [agent,id]);
    const counts=result.rows[0]!;
    const state=job?.state ?? (counts.completed===counts.total ? 'completed' as const : 'review' as const);
    return { ...counts,state,reason: job?.reason ?? null,pending: state==='pending' };
  }
  async delete(agent: string, id: string, key: string) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['library-upload',agent])]);
      const digest = importDigest(['delete-upload',id]);
      const receipt = (await client.query<{ request_digest: string }>(`SELECT request_digest FROM reader.library_import_review_command
        WHERE agent=$1 AND idempotency_key=$2`,[agent,key])).rows[0];
      if (receipt && receipt.request_digest !== digest) throw new ReaderImportConflict('Delete key belongs to another operation');
      if (!receipt) {
        await deleteLibraryUploads(client,agent,[id]);
        await client.query(`INSERT INTO reader.library_import_review_command(agent,idempotency_key,request_digest)
          VALUES ($1,$2,$3)`,[agent,key,digest]);
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK');throw error; } finally { client.release(); }
  }
}
