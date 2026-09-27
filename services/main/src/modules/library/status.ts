import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { VerifiedPrincipal } from '../access/admission.ts';

const ID = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const KEY = /^[A-Za-z0-9:_./-]{1,128}$/;
export type ReadingStatus = 'want-to-read' | 'reading' | 'read';
export interface StatusState { work: string; status: ReadingStatus | null;
  startedOn: string | null; finishedOn: string | null; version: number; changedAt: string | null }
export interface StatusCommand { agent: string; work: string; status: ReadingStatus | null;
  startedOn: string | null; finishedOn: string | null; expectedVersion: number; idempotencyKey: string }
export interface WorkProgress { structure: string; occurrence: string; selectedRevision: string | null;
  completed: boolean; position: string | null; version: number; changedAt: string }
export class InvalidLibraryStatus extends Error {}
export class StaleLibraryStatus extends Error {}
export class LibraryStatusConflict extends Error {}

const columns = `work, status, started_on::text AS started_on, finished_on::text AS finished_on,
  version::text AS version, changed_at::text AS changed_at`;
interface Row { work: string; status: ReadingStatus | null; started_on: string | null;
  finished_on: string | null; version: string; changed_at: string }
const state = (work: string, row?: Row): StatusState => ({ work, status: row?.status ?? null,
  startedOn: row?.started_on ?? null, finishedOn: row?.finished_on ?? null,
  version: Number(row?.version ?? 0), changedAt: row?.changed_at ?? null });

function validDate(value: string | null) {
  if (value === null) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** An exclusive status slot is separate from Collections: Collection placements
 * permit multiple occurrences, while one Work must change or clear atomically.
 * Reads use one indexed batch; writes serialize the key and exact status row. */
export class ReaderLibraryStatusStore {
  constructor(private readonly pool: Pool) {}

  async batch(agent: string, works: string[]): Promise<StatusState[]> {
    if (!ID.test(agent) || works.length > 24 || new Set(works).size !== works.length
      || works.some(work => !ID.test(work))) throw new InvalidLibraryStatus('invalid status batch');
    if (!works.length) return [];
    const rows = await this.pool.query<Row>(`SELECT ${columns} FROM reader.library_status
      WHERE agent = $1 AND work = ANY($2::text[])`, [agent, works]);
    const found = new Map(rows.rows.map(row => [row.work, row]));
    return works.map(work => state(work, found.get(work)));
  }

  async counts(agent: string): Promise<Record<ReadingStatus, number>> {
    if (!ID.test(agent)) throw new InvalidLibraryStatus('invalid Agent');
    const rows = await this.pool.query<{ status: ReadingStatus; count: string }>(`
      SELECT status, count(*)::text AS count FROM reader.library_status
      WHERE agent = $1 AND status IS NOT NULL GROUP BY status`, [agent]);
    const result: Record<ReadingStatus, number> = { 'want-to-read': 0, reading: 0, read: 0 };
    for (const row of rows.rows) result[row.status] = Number(row.count);
    return result;
  }

  async shelves(agent: string): Promise<{ status: ReadingStatus; count: number; changedAt: string | null }[]> {
    if (!ID.test(agent)) throw new InvalidLibraryStatus('invalid Agent');
    const rows = await this.pool.query<{ status: ReadingStatus; count: string; changed_at: string | null }>(`
      SELECT status, count(*)::text AS count, max(changed_at)::text AS changed_at
      FROM reader.library_status WHERE agent = $1 AND status IS NOT NULL GROUP BY status`, [agent]);
    const found = new Map(rows.rows.map(row => [row.status, row]));
    return (['want-to-read', 'reading', 'read'] as const).map(status => ({ status,
      count: Number(found.get(status)?.count ?? 0), changedAt: found.get(status)?.changed_at ?? null }))
      .sort((a, b) => (b.changedAt ?? '').localeCompare(a.changedAt ?? ''));
  }

  async progress(principal: VerifiedPrincipal, structures: string[]): Promise<Map<string, WorkProgress>> {
    if (structures.length > 24 || structures.some(structure => !ID.test(structure))) {
      throw new InvalidLibraryStatus('invalid progress batch');
    }
    if (!structures.length) return new Map();
    const rows = await this.pool.query<{ structure: string; occurrence: string; selection_key: string;
      completed: boolean; position: string | null; version: string; changed_at: string }>(`
      SELECT DISTINCT ON (structure) structure, occurrence, selection_key, completed, position,
        version::text AS version, updated_at::text AS changed_at
      FROM structure.progress WHERE principal_issuer = $1 AND principal_subject = $2
        AND structure = ANY($3::text[])
      ORDER BY structure, updated_at DESC, occurrence DESC LIMIT 24`,
    [principal.issuer, principal.subject, structures]);
    return new Map(rows.rows.map(row => [row.structure, { structure: row.structure,
      occurrence: row.occurrence, selectedRevision: row.selection_key || null,
      completed: row.completed, position: row.position, version: Number(row.version),
      changedAt: row.changed_at }]));
  }

  async fence(agent: string): Promise<string> {
    if (!ID.test(agent)) throw new InvalidLibraryStatus('invalid Agent');
    const rows = await this.pool.query<{ count: string; versions: string }>(`
      SELECT count(*)::text AS count, coalesce(sum(version), 0)::text AS versions
      FROM reader.library_status WHERE agent = $1`, [agent]);
    return `${rows.rows[0]!.count}:${rows.rows[0]!.versions}`;
  }

  async page(agent: string, status: ReadingStatus, limit: number,
    after?: { work: string; changedAt: string }): Promise<StatusState[]> {
    if (!ID.test(agent) || !['want-to-read', 'reading', 'read'].includes(status)
      || !Number.isInteger(limit) || limit < 1 || limit > 21
      || after && (!ID.test(after.work) || !Number.isFinite(Date.parse(after.changedAt)))) {
      throw new InvalidLibraryStatus('invalid status shelf page');
    }
    const rows = await this.pool.query<Row>(`SELECT ${columns} FROM reader.library_status
      WHERE agent = $1 AND status = $2
        AND ($3::timestamptz IS NULL OR (changed_at, work) < ($3::timestamptz, $4::text))
      ORDER BY changed_at DESC, work DESC LIMIT $5`,
    [agent, status, after?.changedAt ?? null, after?.work ?? null, limit]);
    return rows.rows.map(row => state(row.work, row));
  }

  async write(input: StatusCommand): Promise<StatusState & { replayed: boolean }> {
    if (!ID.test(input.agent) || !ID.test(input.work) || !KEY.test(input.idempotencyKey)
      || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0
      || ![null, 'want-to-read', 'reading', 'read'].includes(input.status)
      || !validDate(input.startedOn) || !validDate(input.finishedOn)
      || (input.status !== 'read' && (input.startedOn !== null || input.finishedOn !== null))
      || (input.startedOn && input.finishedOn && input.startedOn > input.finishedOn)) {
      throw new InvalidLibraryStatus('invalid status command');
    }
    const digest = createHash('sha256').update(JSON.stringify([input.work, input.status,
      input.startedOn, input.finishedOn, input.expectedVersion])).digest('hex');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [JSON.stringify(['library-status-key', input.agent, input.idempotencyKey])]);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [JSON.stringify(['library-status-work', input.agent, input.work])]);
      const prior = await client.query<{ request_digest: string; result: StatusState }>(`
        SELECT request_digest, result FROM reader.library_status_command
        WHERE agent = $1 AND idempotency_key = $2`, [input.agent, input.idempotencyKey]);
      if (prior.rows[0]) {
        if (prior.rows[0].request_digest !== digest || prior.rows[0].result.work !== input.work) {
          throw new LibraryStatusConflict('idempotency key has another status intent');
        }
        await client.query('COMMIT');
        return { ...prior.rows[0].result, replayed: true };
      }
      const current = await client.query<Row>(`SELECT ${columns} FROM reader.library_status
        WHERE agent = $1 AND work = $2 FOR UPDATE`, [input.agent, input.work]);
      const version = Number(current.rows[0]?.version ?? 0);
      if (version !== input.expectedVersion) throw new StaleLibraryStatus('status changed');
      const written = await client.query<Row>(`INSERT INTO reader.library_status
        (agent, work, status, started_on, finished_on, version)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (agent, work) DO UPDATE SET status = EXCLUDED.status,
          started_on = EXCLUDED.started_on, finished_on = EXCLUDED.finished_on,
          version = EXCLUDED.version, changed_at = clock_timestamp()
        RETURNING ${columns}`, [input.agent, input.work, input.status, input.startedOn,
        input.finishedOn, version + 1]);
      const result = state(input.work, written.rows[0]);
      await client.query(`INSERT INTO reader.library_status_command
        (agent, idempotency_key, request_digest, result) VALUES ($1,$2,$3,$4)`,
      [input.agent, input.idempotencyKey, digest, JSON.stringify(result)]);
      await client.query('COMMIT');
      return { ...result, replayed: false };
    } catch (error) {
      await client.query('ROLLBACK');
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
        throw new StaleLibraryStatus('status changed concurrently');
      }
      throw error;
    } finally { client.release(); }
  }
}
