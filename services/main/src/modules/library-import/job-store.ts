import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { LibraryFileMissing, importDigest, type ApplyIntent } from './file-store.ts';
import { ReaderImportConflict } from './reader-import.ts';

export const IMPORT_JOB_LEASE_SECONDS = 60;
export const IMPORT_JOB_STALL_SECONDS = 300;
export type ImportJobState = 'pending' | 'completed' | 'stalled' | 'failed';
export type ImportJobReason = 'no-progress' | 'lease-expired' | 'owner-refused' | 'apply-failed' | 'worker-stopped';
export interface ImportJob { state: ImportJobState; reason: ImportJobReason | null; lease_token: string | null }
export interface ImportJobProgress { total: number; completed: number; issues: number; pending: boolean;
  state: ImportJobState | 'review'; reason: ImportJobReason | null; receipt?: string }
export class ImportJobLeaseLost extends Error {}

const deadlines = `(lease_expires_at<=clock_timestamp()
  OR last_progress_at<=clock_timestamp()-interval '${IMPORT_JOB_STALL_SECONDS} seconds')`;

/** The status read is a watchdog too: a stopped process cannot leave an accepted job pending forever. */
export class LibraryImportJobStore {
  constructor(readonly pool: Pool) {}
  async expire() {
    await this.pool.query(`WITH expired AS (SELECT agent,file_id FROM reader.library_import_job
      WHERE state='pending' AND ${deadlines} ORDER BY lease_expires_at LIMIT 100),
    outcomes AS (SELECT j.agent,j.file_id,EXISTS(SELECT 1 FROM reader.library_import_source_row r
      WHERE r.agent=j.agent AND r.file_id=j.file_id AND r.outcome IS NULL) AS unfinished
      FROM reader.library_import_job j JOIN expired e USING(agent,file_id))
    UPDATE reader.library_import_job j SET state=CASE WHEN o.unfinished THEN 'stalled' ELSE 'completed' END,
      reason=CASE WHEN NOT o.unfinished THEN NULL WHEN lease_expires_at<=clock_timestamp() THEN 'lease-expired' ELSE 'no-progress' END,
      lease_token=NULL,lease_expires_at=NULL FROM outcomes o WHERE j.agent=o.agent AND j.file_id=o.file_id AND j.state='pending' AND ${deadlines}`);
  }
  async status(agent: string,id: string) {
    await this.pool.query(`UPDATE reader.library_import_job j SET state='completed',reason=NULL,
      lease_token=NULL,lease_expires_at=NULL WHERE agent=$1 AND file_id=$2 AND state='pending'
      AND NOT EXISTS (SELECT 1 FROM reader.library_import_source_row r
        WHERE r.agent=j.agent AND r.file_id=j.file_id AND r.outcome IS NULL)`,[agent,id]);
    await this.pool.query(`UPDATE reader.library_import_job SET state='stalled',
      reason=CASE WHEN lease_expires_at<=clock_timestamp() THEN 'lease-expired' ELSE 'no-progress' END,
      lease_token=NULL,lease_expires_at=NULL WHERE agent=$1 AND file_id=$2 AND state='pending' AND ${deadlines}`,[agent,id]);
    return (await this.pool.query<ImportJob>(`SELECT state,reason,lease_token FROM reader.library_import_job
      WHERE agent=$1 AND file_id=$2`,[agent,id])).rows[0] ?? null;
  }
  /** `seal` runs in the receipt's transaction: a refused command seals nothing. */
  async accept(agent: string,id: string,key: string,intent: ApplyIntent,resume: boolean,
    seal?: (client: PoolClient) => Promise<void>) {
    const client = await this.pool.connect();
    const digest = importDigest([id,intent,resume]);
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['library-apply',agent,key])]);
      const prior = (await client.query<{ request_digest: string; result: ImportJobProgress }>(`
        SELECT request_digest,result FROM reader.library_import_apply_command WHERE agent=$1 AND idempotency_key=$2`,[agent,key])).rows[0];
      if (prior) {
        if (prior.request_digest!==digest) throw new ReaderImportConflict('Apply key belongs to another intent');
        await client.query('COMMIT');return { result: prior.result,token: null };
      }
      const file = await client.query(`SELECT id FROM reader.library_import_file WHERE agent=$1 AND id=$2
        AND expires_at>clock_timestamp() FOR UPDATE`,[agent,id]);
      if (!file.rowCount) throw new LibraryFileMissing('Import file was deleted, expired or is unavailable');
      await seal?.(client);
      let job = (await client.query<ImportJob>(`SELECT state,reason,lease_token FROM reader.library_import_job
        WHERE agent=$1 AND file_id=$2 FOR UPDATE`,[agent,id])).rows[0];
      const counts=(await client.query<{ total: number; completed: number; issues: number }>(`SELECT count(*)::integer AS total,
        count(outcome)::integer AS completed,count(*) FILTER(WHERE jsonb_array_length(outcome->'issues')>0)::integer AS issues
        FROM reader.library_import_source_row WHERE agent=$1 AND file_id=$2`,[agent,id])).rows[0]!;
      let token: string | null = null;
      if ((!job || resume && ['failed','stalled'].includes(job.state)) && counts.completed<counts.total) {
        token=randomUUID();
        await client.query(`INSERT INTO reader.library_import_job(agent,file_id,state,lease_token,lease_expires_at)
          VALUES ($1,$2,'pending',$3,clock_timestamp()+interval '${IMPORT_JOB_LEASE_SECONDS} seconds')
          ON CONFLICT (agent,file_id) DO UPDATE SET state='pending',reason=NULL,lease_token=$3,
            lease_expires_at=clock_timestamp()+interval '${IMPORT_JOB_LEASE_SECONDS} seconds',
            last_progress_at=clock_timestamp(),started_at=clock_timestamp()`,[agent,id,token]);
        job={ state: 'pending',reason: null,lease_token: token };
      }
      const result: ImportJobProgress = { ...counts,state: job?.state ?? 'completed',reason: job?.reason ?? null,
        pending: job?.state==='pending',receipt: `urn:rezics:receipt:${importDigest([agent,key,digest])}` };
      await client.query(`INSERT INTO reader.library_import_apply_command(agent,idempotency_key,request_digest,file_id,result)
        VALUES ($1,$2,$3,$4,$5)`,[agent,key,digest,id,JSON.stringify(result)]);
      await client.query('COMMIT');return { result,token };
    } catch (error) { await client.query('ROLLBACK');throw error; } finally { client.release(); }
  }
  async renew(agent: string,id: string,token: string) {
    const result = await this.pool.query(`UPDATE reader.library_import_job
      SET lease_expires_at=clock_timestamp()+interval '${IMPORT_JOB_LEASE_SECONDS} seconds'
      WHERE agent=$1 AND file_id=$2 AND state='pending' AND lease_token=$3 AND NOT ${deadlines}`,[agent,id,token]);
    if (!result.rowCount) { await this.status(agent,id);throw new ImportJobLeaseLost('Import worker lease expired'); }
  }
  async progress(agent: string,id: string,token: string,client: Pool | PoolClient = this.pool) {
    const result = await client.query(`UPDATE reader.library_import_job SET last_progress_at=clock_timestamp(),
      lease_expires_at=clock_timestamp()+interval '${IMPORT_JOB_LEASE_SECONDS} seconds'
      WHERE agent=$1 AND file_id=$2 AND state='pending' AND lease_token=$3 AND NOT ${deadlines}`,[agent,id,token]);
    if (!result.rowCount) throw new ImportJobLeaseLost('Import worker lease expired');
  }
  async finish(agent: string,id: string,token: string,state: ImportJobState,reason: ImportJobReason | null = null) {
    await this.status(agent,id);
    await this.pool.query(`UPDATE reader.library_import_job SET state=$4,reason=$5,lease_token=NULL,lease_expires_at=NULL
      WHERE agent=$1 AND file_id=$2 AND state='pending' AND lease_token=$3`,[agent,id,token,state,reason]);
  }
}
