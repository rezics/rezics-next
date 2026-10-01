import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { FILE_IMPORT_COST, type CanonicalRow, type LibraryFileFormat } from './formats/contract.ts';
import { ReaderImportConflict, ReaderImportUnavailable } from './reader-import.ts';

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

/** One bulk insert; pages and apply use the (agent,file,row) keyset. All review
 * mutations lock the file before rows, so apply seals one immutable intent. */
export class LibraryFileStore {
  constructor(readonly pool: Pool) {}
  async create(agent: string, key: string, digest: string, format: LibraryFileFormat, rows: CanonicalRow[]) {
    const id = fileIdentity(agent, key), client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO reader.library_import_batch(agent,import_key,request_digest,row_count)
        VALUES ($1,$2,$3,$4) ON CONFLICT (agent,import_key) DO NOTHING`, [agent,key,digest,rows.length]);
      const prior = await client.query<{ request_digest: string }>(`SELECT request_digest FROM reader.library_import_batch
        WHERE agent=$1 AND import_key=$2 FOR UPDATE`, [agent,key]);
      if (prior.rows[0]?.request_digest !== digest) throw new ReaderImportConflict('Import key belongs to another file or mapping');
      await client.query(`INSERT INTO reader.library_import_file(agent,id,import_key,format)
        VALUES ($1,$2,$3,$4)
        ON CONFLICT DO NOTHING`, [agent,id,key,format]);
      await client.query(`INSERT INTO reader.library_import_source_row(agent,file_id,row_number,source)
        SELECT $1,$2,(ordinal-1)::integer,value FROM jsonb_array_elements($3::jsonb) WITH ORDINALITY AS r(value,ordinal)
        ON CONFLICT DO NOTHING`, [agent,id,JSON.stringify(rows)]);
      await client.query('COMMIT');
      return { id, total: rows.length };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async file(agent: string, id: string) {
    const result = await this.pool.query<{ import_key: string; format: LibraryFileFormat; apply_intent: ApplyIntent | null }>(`
      SELECT import_key,format,apply_intent FROM reader.library_import_file WHERE agent=$1 AND id=$2`, [agent,id]);
    if (!result.rows[0]) throw new ReaderImportUnavailable('Import file is unavailable');
    return result.rows[0];
  }
  async page(agent: string, id: string, after: number, limit = FILE_IMPORT_COST.page as number) {
    await this.file(agent,id);
    const result = await this.pool.query<SourceRecord>(`SELECT row_number,source,match,resolution,outcome,version::text
      FROM reader.library_import_source_row WHERE agent=$1 AND file_id=$2 AND row_number>$3
      ORDER BY row_number LIMIT $4`, [agent,id,after,limit+1]);
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
        WHERE agent=$1 AND id=$2 FOR UPDATE`, [agent,id]);
      if (!file.rows[0]) throw new ReaderImportUnavailable('Import file is unavailable');
      if (file.rows[0].apply_intent) throw new ReaderImportConflict('Application has started; row choices are sealed');
      const row = await client.query<SourceRecord>(`SELECT row_number,source,match,resolution,outcome,version::text
        FROM reader.library_import_source_row WHERE agent=$1 AND file_id=$2 AND row_number=$3 FOR UPDATE`, [agent,id,index]);
      if (!row.rows[0]) throw new ReaderImportUnavailable('Import row is unavailable');
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
        WHERE agent=$1 AND id=$2 FOR UPDATE`, [agent,id]);
      if (!held.rows[0]) throw new ReaderImportUnavailable('Import file is unavailable');
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
    const rows = await this.pool.query<SourceRecord>(`SELECT row_number,source,match,resolution,outcome,version::text
      FROM reader.library_import_source_row WHERE agent=$1 AND file_id=$2 AND outcome IS NULL
      ORDER BY row_number LIMIT ${FILE_IMPORT_COST.page}`, [agent,id]);
    return rows.rows.map(unpack);
  }
  async complete(agent: string, id: string, index: number, outcome: NonNullable<StoredSourceRow['outcome']>) {
    await this.pool.query(`UPDATE reader.library_import_source_row SET outcome=$4,version=version+1
      WHERE agent=$1 AND file_id=$2 AND row_number=$3 AND outcome IS NULL`, [agent,id,index,JSON.stringify(outcome)]);
  }
  async progress(agent: string, id: string) {
    const result = await this.pool.query<{ total: number; completed: number; issues: number }>(`SELECT count(*)::integer AS total,
      count(outcome)::integer AS completed,
      count(*) FILTER (WHERE jsonb_array_length(outcome->'issues')>0)::integer AS issues
      FROM reader.library_import_source_row WHERE agent=$1 AND file_id=$2`, [agent,id]);
    return { ...result.rows[0]!, pending: result.rows[0]!.completed < result.rows[0]!.total };
  }
}
