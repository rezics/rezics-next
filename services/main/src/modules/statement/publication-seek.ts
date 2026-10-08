import type { Pool, PoolClient } from 'pg';
import { runWorkerTick } from '../../worker-tick.ts';
import { lockAccessKey } from '../access/scope-gates.ts';
import { WorkReadUnavailable } from '../work/read-session.ts';
import type { StatementSeekCandidate } from './seek.ts';

export const STATEMENT_PUBLICATION_SEEK_COST = { candidates: 20, buildEntries: 128 } as const;

/** The graph caller must capture and finally recheck actual absence, never a
 * null active-policy match. The Access recovery basis is its existing fence. */
export interface StatementPublicationBasis {
  dataEpoch: string;
  subject: string;
  membershipHead: string | null;
  recoveryBasis: string;
  global: 'no-current-facts';
  sourceStore: string;
}
/** Opaque native record order; never a SQL/API delivery cursor. */
export interface StatementPublicationPhysicalCursor { storage: string; phase: 0 | 1 | 2; key: string; seal: string }
export interface StatementPublicationPhysicalPage {
  after: StatementPublicationPhysicalCursor;
  rawExamined: number;
  exhausted: boolean;
}
export interface StatementPublicationOrder { predicate: string; meaningKey: string; statementId: string }
export interface StatementPublicationReference extends StatementPublicationOrder {
  subject: string;
  head: string;
  source: string | null;
  hasEvidence: boolean;
  frameRefs: { slot: string; iri: string }[];
}
export interface StatementPublicationCheckpoint {
  basis: StatementPublicationBasis;
  buildId: string;
  stepRevision: string;
  phase: 'clearing' | 'building';
  physicalAfter: StatementPublicationPhysicalCursor | null;
  complete: boolean;
}
interface CoverageRow {
  membership_head: string | null; recovery_basis: string; complete: boolean;
  build_id: string; step_revision: string; phase: 'clearing' | 'building';
  native_storage: string;
  physical_cursor: StatementPublicationPhysicalCursor | null;
}
const native = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const meaning = /^urn:rezics:meaning:[0-9a-f]{64}$/u;
const decimal = /^(0|[1-9][0-9]*)$/u;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const iri = (value: string) => value.length <= 500 && /^(https?:\/\/|urn:)[^\s<>"{}|\\^`]+$/u.test(value);
const unavailable = (message: string): never => { throw new WorkReadUnavailable(message); };
function validateBasis(basis: StatementPublicationBasis) {
  if (!basis || basis.global !== 'no-current-facts' || !basis.dataEpoch || basis.dataEpoch.length > 200
    || !native.test(basis.subject) || !decimal.test(basis.recoveryBasis)
    || typeof basis.sourceStore !== 'string' || !basis.sourceStore || basis.sourceStore.length > 500
    || basis.membershipHead !== null && !iri(basis.membershipHead)) unavailable('Publication seek basis is invalid');
}
function validateOrder(order: StatementPublicationOrder) {
  if (!order || !iri(order.predicate) || !meaning.test(order.meaningKey) || !native.test(order.statementId))
    unavailable('Publication seek cursor is invalid');
}
function validatePhysical(cursor: StatementPublicationPhysicalCursor, storage: string) {
  if (!cursor || cursor.storage !== storage || ![0,1,2].includes(cursor.phase)
    || typeof cursor.seal !== 'string' || !/^[0-9a-f]{64}$/u.test(cursor.seal)
    || typeof cursor.key !== 'string' || (cursor.phase === 2 ? cursor.key !== ''
      : cursor.key !== '' && !(cursor.phase === 0 ? /^[0-9a-f]{64}$/u : /^[0-9a-f]{48}$/u).test(cursor.key)))
    unavailable('Publication physical cursor is invalid');
}
function samePhysical(left: StatementPublicationPhysicalCursor | null, right: StatementPublicationPhysicalCursor | null) {
  return left === null ? right === null : right !== null
    && left.storage === right.storage && left.phase === right.phase && left.key === right.key && left.seal === right.seal;
}
function matches(row: CoverageRow, basis: StatementPublicationBasis) {
  return row.membership_head === basis.membershipHead && row.recovery_basis === basis.recoveryBasis
    && row.native_storage === basis.sourceStore;
}
function checkpoint(row: CoverageRow, basis: StatementPublicationBasis): StatementPublicationCheckpoint {
  return {basis,buildId: row.build_id,stepRevision: row.step_revision,phase: row.phase,complete: row.complete,
    physicalAfter: row.physical_cursor};
}
function validateCheckpoint(value: StatementPublicationCheckpoint) {
  validateBasis(value.basis);
  if (!uuid.test(value.buildId) || !decimal.test(value.stepRevision)
    || !['clearing','building'].includes(value.phase)) unavailable('Publication build checkpoint is invalid');
  if (value.physicalAfter) validatePhysical(value.physicalAfter,value.basis.sourceStore);
  if (value.complete && (value.phase !== 'building' || value.physicalAfter?.phase !== 2))
    unavailable('Publication completion has no native EOF');
}
export const statementPublicationCandidateSql = (after: boolean) => `SELECT subject,predicate,meaning_key,statement_id,statement_head
  FROM access.statement_seek WHERE data_epoch=$1 AND subject=$2 AND frame_key='*'
    AND statement_head IS NOT NULL AND (publication_source IS NOT NULL OR publication_evidence)
    ${after ? 'AND (predicate,meaning_key,statement_id)>($3,$4,$5)' : ''}
  ORDER BY predicate,meaning_key,statement_id LIMIT ${STATEMENT_PUBLICATION_SEEK_COST.candidates}`;

/** Data/checkpoint operations used by the existing StatementSeek owner. This
 * helper neither discovers graph membership nor decides publication/disclosure. */
export class StatementPublicationSeek {
  constructor(private readonly pool: Pool) {}

  private async transaction<T>(basis: StatementPublicationBasis, write: boolean,
    operation: (client: PoolClient) => Promise<T>): Promise<T> {
    validateBasis(basis);
    // connect() would otherwise leave its hold on the Statement seek tick that
    // called this step, and on every worker that continues in that context.
    return runWorkerTick('statement-publication-seek', () => this.transact(basis, write, operation));
  }
  private async transact<T>(basis: StatementPublicationBasis, write: boolean,
    operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      // FOR SHARE keeps the existing recovery fence stable through this bounded read.
      await client.query(write ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ');
      const fence = (await client.query<{generation: string; open: boolean}>(
        'SELECT generation::text,open FROM access.recovery_fence WHERE id=true FOR SHARE')).rows[0];
      if (!fence?.open || fence.generation !== basis.recoveryBasis) unavailable('Publication seek recovery is unavailable');
      if (write) await lockAccessKey(client,`statement-publication:${JSON.stringify([basis.dataEpoch,basis.subject])}`);
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }
  private async row(client: PoolClient, basis: StatementPublicationBasis, lock = false) {
    return (await client.query<CoverageRow>(`SELECT membership_head,recovery_basis::text,complete,build_id::text,
      step_revision::text,phase,native_storage,physical_cursor
      FROM access.statement_publication_seek_coverage WHERE data_epoch=$1 AND subject=$2 ${lock ? 'FOR UPDATE' : ''}`,
    [basis.dataEpoch,basis.subject])).rows[0];
  }
  private async checkedRow(client: PoolClient, value: StatementPublicationCheckpoint) {
    const row = await this.row(client,value.basis,true);
    if (!row || !matches(row,value.basis) || row.build_id !== value.buildId || row.step_revision !== value.stepRevision
      || row.phase !== value.phase || row.complete || !samePhysical(row.physical_cursor,value.physicalAfter))
      unavailable('Publication build checkpoint moved');
    return row;
  }
  async checkpoint(basis: StatementPublicationBasis): Promise<StatementPublicationCheckpoint | null> {
    return this.transaction(basis,false,async client => {
      const row = await this.row(client,basis);
      if (!row || !matches(row,basis)) return null;
      const value = checkpoint(row,basis);
      validateCheckpoint(value);
      return value;
    });
  }
  async begin(basis: StatementPublicationBasis): Promise<StatementPublicationCheckpoint> {
    return this.transaction(basis,true,async client => {
      const current = await this.row(client,basis,true);
      if (current && matches(current,basis)) {
        const value = checkpoint(current,basis);
        validateCheckpoint(value);
        return value;
      }
      // Preserve the raw owner's epoch/coverage; never claim its global replay completed.
      await client.query(`INSERT INTO access.statement_seek_coverage(data_epoch,through_sequence,complete)
        VALUES ($1,0,false) ON CONFLICT DO NOTHING`,[basis.dataEpoch]);
      const buildId = Bun.randomUUIDv7();
      const row = (await client.query<CoverageRow>(`INSERT INTO access.statement_publication_seek_coverage
        (data_epoch,subject,membership_head,recovery_basis,build_id,native_storage,complete,phase,step_revision)
        VALUES ($1,$2,$3,$4,$5,$6,false,'clearing',0)
        ON CONFLICT (data_epoch,subject) DO UPDATE SET membership_head=excluded.membership_head,
          recovery_basis=excluded.recovery_basis,build_id=excluded.build_id,complete=false,phase='clearing',step_revision=0,
          native_storage=excluded.native_storage,physical_cursor=NULL
        RETURNING membership_head,recovery_basis::text,complete,build_id::text,step_revision::text,phase,
          native_storage,physical_cursor`,
      [basis.dataEpoch,basis.subject,basis.membershipHead,basis.recoveryBasis,buildId,basis.sourceStore])).rows[0]!;
      return checkpoint(row,basis);
    });
  }
  private async advance(client: PoolClient, value: StatementPublicationCheckpoint,
    phase: 'clearing' | 'building', after: StatementPublicationPhysicalCursor | null, complete: boolean) {
    const row = (await client.query<CoverageRow>(`UPDATE access.statement_publication_seek_coverage
      SET phase=$5,physical_cursor=$6::jsonb,complete=$7,step_revision=step_revision+1
      WHERE data_epoch=$1 AND subject=$2 AND build_id=$3 AND step_revision=$4
      RETURNING membership_head,recovery_basis::text,complete,build_id::text,step_revision::text,phase,
        native_storage,physical_cursor`,
    [value.basis.dataEpoch,value.basis.subject,value.buildId,value.stepRevision,phase,
      after === null ? null : JSON.stringify(after),complete])).rows[0];
    if (!row) unavailable('Publication build CAS refused');
    return checkpoint(row,value.basis);
  }
  async clearBatch(value: StatementPublicationCheckpoint): Promise<StatementPublicationCheckpoint> {
    validateCheckpoint(value);
    if (value.phase !== 'clearing') unavailable('Publication build is not clearing');
    return this.transaction(value.basis,true,async client => {
      await this.checkedRow(client,value);
      const rows = (await client.query<{statement_id: string; predicate: string; meaning_key: string}>(`SELECT statement_id,predicate,meaning_key FROM access.statement_seek
        WHERE data_epoch=$1 AND subject=$2 AND frame_key='*' AND statement_head IS NOT NULL
          AND (publication_source IS NOT NULL OR publication_evidence)
        ORDER BY predicate,meaning_key,statement_id LIMIT ${STATEMENT_PUBLICATION_SEEK_COST.buildEntries}`,
      [value.basis.dataEpoch,value.basis.subject])).rows;
      if (rows.length) await client.query(`UPDATE access.statement_seek SET statement_head=NULL,
        publication_source=NULL,publication_evidence=false WHERE data_epoch=$1 AND subject=$2 AND frame_key='*'
        AND (predicate,meaning_key,statement_id) IN (SELECT * FROM unnest($3::text[],$4::text[],$5::text[]))`,
      [value.basis.dataEpoch,value.basis.subject,rows.map(row => row.predicate),rows.map(row => row.meaning_key),rows.map(row => row.statement_id)]);
      return this.advance(client,value,rows.length < STATEMENT_PUBLICATION_SEEK_COST.buildEntries ? 'building' : 'clearing',null,false);
    });
  }
  async append(value: StatementPublicationCheckpoint, references: readonly StatementPublicationReference[],
    page: StatementPublicationPhysicalPage, verifyBasis: () => Promise<boolean>): Promise<StatementPublicationCheckpoint> {
    validateCheckpoint(value);
    if (!page || value.phase !== 'building' || references.length > STATEMENT_PUBLICATION_SEEK_COST.buildEntries - 1
      || !Number.isInteger(page.rawExamined) || page.rawExamined < references.length || page.rawExamined > 128
      || typeof page.exhausted !== 'boolean' || typeof verifyBasis !== 'function')
      unavailable('Publication build step is invalid');
    validatePhysical(page.after,value.basis.sourceStore);
    if (page.exhausted !== (page.after.phase === 2) || value.physicalAfter?.phase === 2
      || samePhysical(value.physicalAfter,page.after) || value.physicalAfter && page.after.phase < value.physicalAfter.phase
      || value.physicalAfter && page.after.phase === value.physicalAfter.phase && page.after.key <= value.physicalAfter.key
      || !page.rawExamined && !page.exhausted && (!value.physicalAfter || page.after.phase === value.physicalAfter.phase))
      unavailable('Publication build made no physical progress');
    const seen = new Set<string>();
    for (const ref of references) {
      validateOrder(ref);
      if (ref.subject !== value.basis.subject || !native.test(ref.head) || ref.source !== null && !native.test(ref.source)
        || typeof ref.hasEvidence !== 'boolean' || !Array.isArray(ref.frameRefs) || ref.frameRefs.length > 8
        || ref.frameRefs.some(frame => typeof frame.slot !== 'string' || !frame.slot || !iri(frame.iri))
        || seen.has(ref.statementId)) unavailable('Publication build reference is invalid');
      seen.add(ref.statementId);
    }
    return this.transaction(value.basis,true,async client => {
      await this.checkedRow(client,value);
      for (const ref of references) {
        if (ref.source !== null || ref.hasEvidence) {
          await client.query(`INSERT INTO access.statement_seek
            (data_epoch,subject,predicate,meaning_key,statement_id,frame_key,frame_refs,statement_head,publication_source,publication_evidence)
            VALUES ($1,$2,$3,$4,$5,'*',$6::jsonb,$7,$8,$9)
            ON CONFLICT (data_epoch,subject,frame_key,predicate,meaning_key,statement_id) DO UPDATE
              SET statement_head=excluded.statement_head,publication_source=excluded.publication_source,
                publication_evidence=excluded.publication_evidence`,
          [value.basis.dataEpoch,ref.subject,ref.predicate,ref.meaningKey,ref.statementId,JSON.stringify(ref.frameRefs),ref.head,ref.source,ref.hasEvidence]);
        }
      }
      if (!await verifyBasis()) unavailable('Publication build source basis moved');
      return this.advance(client,value,'building',page.after,page.exhausted);
    });
  }
  async seek(basis: StatementPublicationBasis, after: StatementPublicationOrder | null) {
    validateBasis(basis);
    if (after) validateOrder(after);
    return this.transaction(basis,false,async client => {
      const coverage = await this.row(client,basis);
      if (!coverage?.complete || !matches(coverage,basis)) unavailable('Publication seek local coverage is unavailable');
      validateCheckpoint(checkpoint(coverage,basis));
      const rows = (await client.query<{subject: string; predicate: string; meaning_key: string; statement_id: string; statement_head: string}>(
        statementPublicationCandidateSql(after !== null),
        [basis.dataEpoch,basis.subject,...after ? [after.predicate,after.meaningKey,after.statementId] : []])).rows;
      const candidates: StatementSeekCandidate[] = rows.map(row => {
        const ref = {predicate: row.predicate,meaningKey: row.meaning_key,statementId: row.statement_id};
        validateOrder(ref);
        if (row.subject !== basis.subject || !native.test(row.statement_head)) unavailable('Publication seek reference is invalid');
        return {...ref,score: 0};
      });
      return {candidates,visitedRows: rows.length};
    });
  }
}
