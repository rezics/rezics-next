import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { NATIVE_ID, derivedId } from '../structure/graph.ts';
import { WorkReadInvalid, WorkReadUnavailable } from '../work/read-session.ts';

export const REVELATION_COST = { batch: 50, lookupSql: 1, writeSql: 1, progressSql: 1, snapshotSql: 1 } as const;
export interface Revelation {
  record: string;
  recordKind: 'entity' | 'name' | 'alias' | 'statement' | 'relation';
  continuityWork: string;
  occurrence: string;
  receipt: string;
}
export class RevelationConflict extends Error {}

/** Component properties have no separate graph identity. Publishers and readers
 * use this identity for the exact value, so a later alias cannot reveal its name. */
export function propertyRevelationRecord(resource: string, predicate: string, value: unknown): string {
  const ordered = value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value;
  return derivedId(`wiki-property-v1\0${resource}\0${predicate}\0${JSON.stringify(ordered)}`);
}

export class ReadingPositionStore {
  constructor(private readonly pool: Pool) {}
  async generation(): Promise<string> {
    const result = await this.pool.query<{ version: string }>(`SELECT version::text AS version
      FROM reading_position.generation WHERE singleton`);
    if (result.rows.length !== 1) throw new WorkReadUnavailable('Revelation generation is unavailable');
    return result.rows[0]!.version;
  }
  /** One read of this reader's existing owner state; no counter table or writes.
   * Call only after Access proves this principal owns the Person, never for an
   * arbitrary acting Agent. Cost is linear in that reader's indexed history. */
  async privateSnapshot(principal: VerifiedPrincipal, agent: string): Promise<string> {
    const result = await this.pool.query<{ snapshot: string }>(`SELECT md5(concat_ws('|',
      (SELECT string_agg(concat_ws(':', structure, occurrence, selection_key, version, completed), '|' ORDER BY structure, occurrence, selection_key)
        FROM structure.progress WHERE principal_issuer = $1 AND principal_subject = $2),
      (SELECT string_agg(concat_ws(':', id, version), '|' ORDER BY id)
        FROM reader.consumption_session WHERE principal_issuer = $1 AND principal_subject = $2 AND agent = $3),
      (SELECT string_agg(concat_ws(':', work, version, status), '|' ORDER BY work)
        FROM reader.library_status WHERE agent = $3))) AS snapshot`, [principal.issuer, principal.subject, agent]);
    return result.rows[0]!.snapshot;
  }
  async lookup(records: readonly string[]): Promise<Map<string, Revelation[]>> {
    if (records.length > REVELATION_COST.batch) throw new WorkReadInvalid('Revelation batch exceeds 50 records');
    if (!records.length) return new Map();
    const result = await this.pool.query<Revelation>(`SELECT record, record_kind AS "recordKind",
      continuity_work AS "continuityWork", occurrence, receipt
      FROM reading_position.revelation WHERE record = ANY($1::text[])`, [records]);
    const found = new Map<string, Revelation[]>();
    for (const row of result.rows) found.set(row.record, [...found.get(row.record) ?? [], row]);
    return found;
  }
  /** Only the reviewed publication/correction owner calls this in its transaction.
   * Readers never write. Corrections update an existing row under its prior
   * receipt; a concurrent removal must not turn a correction into publication. */
  async write(client: Pick<PoolClient, 'query'>, row: Revelation, expectedReceipt: string | null): Promise<void> {
    if (![row.record, row.continuityWork, row.occurrence].every(value => NATIVE_ID.test(value))
      || !['entity', 'name', 'alias', 'statement', 'relation'].includes(row.recordKind) || !row.receipt) {
      throw new WorkReadInvalid('Revelation identity is invalid');
    }
    const values = [row.record, row.recordKind, row.continuityWork, row.occurrence, row.receipt];
    const result = expectedReceipt === null ? await client.query(`INSERT INTO reading_position.revelation
      (record, record_kind, continuity_work, occurrence, receipt) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (record, continuity_work) DO UPDATE SET record_kind = EXCLUDED.record_kind,
        occurrence = EXCLUDED.occurrence, receipt = EXCLUDED.receipt
      WHERE (reading_position.revelation.receipt = EXCLUDED.receipt
          AND reading_position.revelation.record_kind = EXCLUDED.record_kind
          AND reading_position.revelation.continuity_work = EXCLUDED.continuity_work
          AND reading_position.revelation.occurrence = EXCLUDED.occurrence)
      RETURNING record`, values) : await client.query(`UPDATE reading_position.revelation
        SET record_kind = $2, continuity_work = $3, occurrence = $4, receipt = $5
        WHERE record = $1 AND continuity_work = $3 AND (receipt = $6 OR
          (receipt = $5 AND record_kind = $2 AND continuity_work = $3 AND occurrence = $4))
        RETURNING record`, [...values, expectedReceipt]);
    if (result.rowCount !== 1) throw new RevelationConflict('Revelation receipt changed');
  }
  async completed(principal: VerifiedPrincipal, structures: readonly string[]): Promise<Set<string>> {
    if (!structures.length) return new Set();
    const result = await this.pool.query<{ occurrence: string }>(`SELECT DISTINCT occurrence
      FROM structure.progress WHERE principal_issuer = $1 AND principal_subject = $2
        AND structure = ANY($3::text[]) AND completed`, [principal.issuer, principal.subject, structures]);
    return new Set(result.rows.map(row => row.occurrence));
  }
  async finishedWorks(agent: string, works: readonly string[]): Promise<Set<string>> {
    if (works.length > REVELATION_COST.batch) throw new WorkReadInvalid('Finished Work batch exceeds 50 records');
    const result = await this.pool.query<{ work: string }>(`SELECT work FROM reader.library_status
      WHERE agent = $1 AND work = ANY($2::text[]) AND status = 'read'`, [agent, works]);
    return new Set(result.rows.map(row => row.work));
  }
}
