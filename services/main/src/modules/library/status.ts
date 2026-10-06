import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from '../access/admission.ts';

const ID = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const KEY = /^[A-Za-z0-9:_./-]{1,128}$/;
export type ShelfSort = 'added' | 'title' | 'rating' | 'last-read' | 'finished';
export type ShelfOrder = 'asc' | 'desc';
export interface ShelfAfter { work: string; value: string | null }
export interface ShelfRow extends StatusState { sortValue: string | null }
export const STATUS_SHELF_COST = { candidateBatch: 20, countBatch: 64, pageSize: 20, countStatements: 1,
  candidateBatches: 2, progressStructures: 24,
  ordering: 'SQL keyset O(log N + P)', fence: 'per-person revision point read',
  progress: 'one indexed top-one seek per Structure', nulls: 'last' } as const;
export type ShelfMetadata = { titleKey: string | null; ownRating: number | null; lastReadAt: string | null };
const metadataReaders = new WeakMap<Pool, (agent: string, work: string, transaction: PoolClient) => Promise<ShelfMetadata>>();
const followWriters = new WeakMap<Pool, (agent: string, work: string) => Promise<void>>();
export function configureLibraryFollow(pool: Pool, write: (agent: string, work: string) => Promise<void>) {
  followWriters.set(pool,write);
}
export function configureShelfMetadata(pool: Pool, read: (agent: string, work: string, transaction: PoolClient) => Promise<ShelfMetadata>) {
  metadataReaders.set(pool, read);
}
export type ReadingStatus = 'want-to-read' | 'reading' | 'read';
export interface StatusState { work: string; status: ReadingStatus | null;
  startedOn: string | null; finishedOn: string | null; version: number; changedAt: string | null }
export interface StatusCommand { agent: string; work: string; status: ReadingStatus | null;
  /** Omitted dates keep their saved value; null clears only the named field. */
  startedOn?: string | null; finishedOn?: string | null; expectedVersion: number; idempotencyKey: string;
  /** Internal session owner only, within the same Content transaction. */
  sessionProjection?: string;
  /** Internal sort keys, excluded from user intent and receipts. */
  shelfMetadata?: ShelfMetadata; titleKey?: string }
export interface WorkProgress { structure: string; occurrence: string; selectedRevision: string | null;
  completed: boolean; position: string | null; version: number; changedAt: string }
export class InvalidLibraryStatus extends Error {}
export class StaleLibraryStatus extends Error {}
export class LibraryStatusConflict extends Error {}
export interface YearlyGoal { year: number; target: number | null; completed: number;
  version: number; changedAt: string | null; replayed?: boolean }
export const READING_TOTALS_COST = { sqlStatements: 1, resultRows: 12, responseBytes: 8 * 1024 } as const;
/** Rich graph-derived details still require an owner aggregate projection. */
export const READING_STATS_COST = { finishedWorks: 240, detailBatch: 20, conceptPairsPerWork: 8 } as const;
export interface ReadingMonth { month: number; books: number; chapters: number }
export interface ReadingYear { year: number; books: number; chapters: number; months: ReadingMonth[] }
export interface PrivateImportReview { work: string; text: string; language: string;
  spoiler: boolean; version: number; changedAt: string; replayed?: boolean }

const columns = `work, status, started_on::text AS started_on, finished_on::text AS finished_on,
  version::text AS version, changed_at::text AS changed_at, session_projection`;
interface Row { work: string; status: ReadingStatus | null; started_on: string | null;
  finished_on: string | null; version: string; changed_at: string; session_projection: string | null }
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

  async privateReviews(agent: string, works: string[]): Promise<PrivateImportReview[]> {
    if (!ID.test(agent) || works.length > 24 || new Set(works).size !== works.length
      || works.some(work => !ID.test(work))) throw new InvalidLibraryStatus('invalid private review batch');
    if (!works.length) return [];
    const rows = await this.pool.query<{ work: string; body: string; language: string; spoiler: boolean;
      version: string; changed_at: string }>(`
      SELECT work, body, language, spoiler, version::text AS version, changed_at::text AS changed_at
      FROM reader.private_import_review WHERE agent = $1 AND work = ANY($2::text[])`, [agent, works]);
    return rows.rows.map(row => ({ work: row.work, text: row.body, language: row.language,
      spoiler: row.spoiler, version: Number(row.version), changedAt: row.changed_at }));
  }

  async putPrivateReview(input: { agent: string; work: string; text: string; language: string;
    spoiler: boolean; expectedVersion: number; idempotencyKey: string }): Promise<PrivateImportReview> {
    if (!ID.test(input.agent) || !ID.test(input.work) || !KEY.test(input.idempotencyKey)
      || input.text.trim() !== input.text || input.text.length < 1 || input.text.length > 8000
      || !/^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(input.language)
      || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
      throw new InvalidLibraryStatus('invalid private review command');
    }
    const digest = createHash('sha256').update(JSON.stringify([input.work, input.text, input.language,
      input.spoiler, input.expectedVersion])).digest('hex');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [JSON.stringify(['private-review-key', input.agent, input.idempotencyKey])]);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [JSON.stringify(['private-review-work', input.agent, input.work])]);
      const prior = await client.query<{ request_digest: string; result: PrivateImportReview }>(`
        SELECT request_digest, result FROM reader.private_import_review_command
        WHERE agent = $1 AND idempotency_key = $2`, [input.agent, input.idempotencyKey]);
      if (prior.rows[0]) {
        if (prior.rows[0].request_digest !== digest) throw new LibraryStatusConflict('review key has another intent');
        await client.query('COMMIT');
        return { ...prior.rows[0].result, replayed: true };
      }
      const current = await client.query<{ version: string }>(`
        SELECT version::text AS version FROM reader.private_import_review
        WHERE agent = $1 AND work = $2 FOR UPDATE`, [input.agent, input.work]);
      const version = Number(current.rows[0]?.version ?? 0);
      if (version !== input.expectedVersion) throw new StaleLibraryStatus('private review changed');
      const written = await client.query<{ changed_at: string }>(`
        INSERT INTO reader.private_import_review (agent, work, body, language, spoiler, version)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (agent, work) DO UPDATE SET body = EXCLUDED.body, language = EXCLUDED.language,
          spoiler = EXCLUDED.spoiler, version = EXCLUDED.version, changed_at = clock_timestamp()
        RETURNING changed_at::text AS changed_at`,
      [input.agent, input.work, input.text, input.language, input.spoiler, version + 1]);
      const result: PrivateImportReview = { work: input.work, text: input.text,
        language: input.language, spoiler: input.spoiler, version: version + 1,
        changedAt: written.rows[0]!.changed_at };
      await client.query(`INSERT INTO reader.private_import_review_command
        (agent, idempotency_key, request_digest, result) VALUES ($1,$2,$3,$4)`,
      [input.agent, input.idempotencyKey, digest, JSON.stringify(result)]);
      await client.query('COMMIT');
      return { ...result, replayed: false };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  /** Whole-year totals are one MVCC snapshot and twelve SQL aggregate rows.
   * Chapter completions use UTC calendar months, independent of the DB timezone.
   * No Work or occurrence inventory is transferred to Main. */
  async readingYear(agent: string, principal: VerifiedPrincipal, year: number): Promise<ReadingYear> {
    if (!ID.test(agent) || !Number.isInteger(year) || year < 1900 || year > 2100) {
      throw new InvalidLibraryStatus('invalid reading stats year');
    }
    const result = await this.pool.query<{ month: number; books: string; chapters: string }>(`
      WITH books AS (
        SELECT extract(month FROM finished_on)::integer AS month, count(*) AS count
        FROM reader.library_status
        WHERE agent = $1 AND status = 'read' AND finished_on >= make_date($4,1,1)
          AND finished_on < make_date($4 + 1,1,1)
        GROUP BY 1
      ), chapters AS (
        SELECT extract(month FROM created_at AT TIME ZONE 'UTC')::integer AS month, count(*) AS count
        FROM structure.progress_command
        WHERE principal_issuer = $2 AND principal_subject = $3 AND first_finish
          AND created_at >= (make_date($4,1,1)::timestamp AT TIME ZONE 'UTC')
          AND created_at < (make_date($4 + 1,1,1)::timestamp AT TIME ZONE 'UTC')
        GROUP BY 1
      )
      SELECT month, coalesce(books.count,0)::text AS books, coalesce(chapters.count,0)::text AS chapters
      FROM generate_series(1,12) AS months(month)
      LEFT JOIN books USING (month) LEFT JOIN chapters USING (month) ORDER BY month`,
    [agent, principal.issuer, principal.subject, year]);
    const months = result.rows.map(row => ({ month: row.month, books: Number(row.books),
      chapters: Number(row.chapters) }));
    return { year, books: months.reduce((total, month) => total + month.books, 0),
      chapters: months.reduce((total, month) => total + month.chapters, 0), months };
  }

  /** Private, bounded Work IDs for the richer year summary. The route never returns them. */
  async finishedWorks(agent: string, year: number): Promise<string[] | null> {
    if (!ID.test(agent) || !Number.isInteger(year) || year < 1900 || year > 2100) {
      throw new InvalidLibraryStatus('invalid reading stats year');
    }
    const rows = await this.pool.query<{ work: string }>(`
      SELECT work FROM reader.library_status
      WHERE agent = $1 AND status = 'read' AND finished_on >= make_date($2,1,1)
        AND finished_on < make_date($2 + 1,1,1)
      ORDER BY finished_on, work LIMIT ${READING_STATS_COST.finishedWorks + 1}`, [agent, year]);
    if (rows.rows.length > READING_STATS_COST.finishedWorks) {
      return null;
    }
    return rows.rows.map(row => row.work);
  }

  async goal(agent: string, year: number): Promise<YearlyGoal> {
    if (!ID.test(agent) || !Number.isInteger(year) || year < 1900 || year > 2100) {
      throw new InvalidLibraryStatus('invalid reading goal');
    }
    const [goal, books] = await Promise.all([
      this.pool.query<{ target: number | null; version: string; changed_at: string }>(`
        SELECT target, version::text AS version, changed_at::text AS changed_at
        FROM reader.yearly_goal WHERE agent = $1 AND year = $2`, [agent, year]),
      this.pool.query<{ count: string }>(`
        SELECT count(*)::text AS count FROM reader.library_status
        WHERE agent = $1 AND status = 'read' AND finished_on >= make_date($2,1,1)
          AND finished_on < make_date($2 + 1,1,1)`, [agent, year]),
    ]);
    return { year, target: goal.rows[0]?.target ?? null, completed: Number(books.rows[0]!.count),
      version: Number(goal.rows[0]?.version ?? 0), changedAt: goal.rows[0]?.changed_at ?? null };
  }

  async setGoal(input: { agent: string; year: number; target: number | null;
    expectedVersion: number; idempotencyKey: string }): Promise<YearlyGoal> {
    if (!ID.test(input.agent) || !KEY.test(input.idempotencyKey)
      || !Number.isInteger(input.year) || input.year < 1900 || input.year > 2100
      || input.target !== null && (!Number.isInteger(input.target) || input.target < 1 || input.target > 1000)
      || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
      throw new InvalidLibraryStatus('invalid reading goal command');
    }
    const digest = createHash('sha256').update(JSON.stringify([input.year, input.target,
      input.expectedVersion])).digest('hex');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [JSON.stringify(['yearly-goal-key', input.agent, input.idempotencyKey])]);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [JSON.stringify(['yearly-goal-year', input.agent, input.year])]);
      const prior = await client.query<{ request_digest: string; result: YearlyGoal }>(`
        SELECT request_digest, result FROM reader.yearly_goal_command
        WHERE agent = $1 AND idempotency_key = $2`, [input.agent, input.idempotencyKey]);
      if (prior.rows[0]) {
        if (prior.rows[0].request_digest !== digest) throw new LibraryStatusConflict('goal key has another intent');
        await client.query('COMMIT');
        return { ...prior.rows[0].result, replayed: true };
      }
      const current = await client.query<{ version: string }>(`
        SELECT version::text AS version FROM reader.yearly_goal
        WHERE agent = $1 AND year = $2 FOR UPDATE`, [input.agent, input.year]);
      const version = Number(current.rows[0]?.version ?? 0);
      if (version !== input.expectedVersion) throw new StaleLibraryStatus('reading goal changed');
      const written = await client.query<{ target: number | null; version: string; changed_at: string }>(`
        INSERT INTO reader.yearly_goal (agent, year, target, version) VALUES ($1,$2,$3,$4)
        ON CONFLICT (agent, year) DO UPDATE SET target = EXCLUDED.target,
          version = EXCLUDED.version, changed_at = clock_timestamp()
        RETURNING target, version::text AS version, changed_at::text AS changed_at`,
      [input.agent, input.year, input.target, version + 1]);
      const books = await client.query<{ count: string }>(`
        SELECT count(*)::text AS count FROM reader.library_status
        WHERE agent = $1 AND status = 'read' AND finished_on >= make_date($2,1,1)
          AND finished_on < make_date($2 + 1,1,1)`, [input.agent, input.year]);
      const result: YearlyGoal = { year: input.year, target: written.rows[0]!.target,
        completed: Number(books.rows[0]!.count), version: Number(written.rows[0]!.version),
        changedAt: written.rows[0]!.changed_at };
      await client.query(`INSERT INTO reader.yearly_goal_command (agent, idempotency_key, request_digest, result)
        VALUES ($1,$2,$3,$4)`, [input.agent, input.idempotencyKey, digest, JSON.stringify(result)]);
      await client.query('COMMIT');
      return { ...result, replayed: false };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async batch(agent: string, works: string[], transaction?: PoolClient): Promise<StatusState[]> {
    if (!ID.test(agent) || works.length > 24 || new Set(works).size !== works.length
      || works.some(work => !ID.test(work))) throw new InvalidLibraryStatus('invalid status batch');
    if (!works.length) return [];
    const rows = await (transaction ?? this.pool).query<Row>(`SELECT ${columns} FROM reader.library_status
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
    if (structures.length > STATUS_SHELF_COST.progressStructures || structures.some(structure => !ID.test(structure))) {
      throw new InvalidLibraryStatus('invalid progress batch');
    }
    if (!structures.length) return new Map();
    const rows = await this.pool.query<{ structure: string; occurrence: string; selection_key: string;
      completed: boolean; position: string | null; version: string; changed_at: string }>(`
      SELECT latest.structure, occurrence, selection_key, completed, position,
        version::text AS version, updated_at::text AS changed_at
      FROM unnest($3::text[]) AS requested(structure)
      CROSS JOIN LATERAL (
        SELECT structure, occurrence, selection_key, completed, position, version, updated_at
        FROM structure.progress WHERE principal_issuer = $1 AND principal_subject = $2
          AND structure = requested.structure
        ORDER BY updated_at DESC, occurrence DESC, selection_key ASC LIMIT 1
      ) AS latest`,
    [principal.issuer, principal.subject, structures]);
    return new Map(rows.rows.map(row => [row.structure, { structure: row.structure,
      occurrence: row.occurrence, selectedRevision: row.selection_key || null,
      completed: row.completed, position: row.position, version: Number(row.version),
      changedAt: row.changed_at }]));
  }

  async fence(agent: string, sort: ShelfSort = 'added'): Promise<string> {
    if (!ID.test(agent)) throw new InvalidLibraryStatus('invalid Agent');
    const keys = { added: '0', finished: '0', title: 'title_revision',
      rating: 'rating_revision', 'last-read': 'progress_revision' };
    if (!Object.hasOwn(keys, sort)) throw new InvalidLibraryStatus('invalid shelf sort');
    const key = keys[sort];
    const rows = await this.pool.query<{ revision: string; sort_revision: string }>(`
      SELECT revision::text AS revision, (${key})::text AS sort_revision
      FROM reader.library_status_revision WHERE agent = $1`, [agent]);
    return `${rows.rows[0]?.revision ?? '0'}:${rows.rows[0]?.sort_revision ?? '0'}`;
  }

  /** Every sort uses an explicit NULLS LAST and a unique Work tiebreaker.
   * https://www.postgresql.org/docs/current/queries-order.html */
  async sortedPage(agent: string, status: ReadingStatus, limit: number,
    sort: ShelfSort = 'added', order: ShelfOrder = sort === 'title' ? 'asc' : 'desc',
    after?: ShelfAfter): Promise<ShelfRow[]> {
    // Qualify database columns: changed_at/finished_on in the output are text
    // aliases, and ORDER BY would otherwise sort those aliases across the shelf.
    // https://www.postgresql.org/docs/18/queries-order.html
    const keys = { added: ['shelf.changed_at', 'timestamptz'], title: ['shelf.title_key COLLATE "C"', 'text'],
      rating: ['shelf.own_rating', 'integer'], 'last-read': ['shelf.last_read_at', 'timestamptz'],
      finished: ['shelf.finished_on', 'date'] } as const;
    if (!ID.test(agent) || !['want-to-read', 'reading', 'read'].includes(status)
      || !Number.isInteger(limit) || limit < 1 || limit > STATUS_SHELF_COST.countBatch || !Object.hasOwn(keys, sort)
      || !['asc', 'desc'].includes(order) || sort === 'finished' && status !== 'read'
      || after && (!ID.test(after.work) || after.value !== null && typeof after.value !== 'string')) {
      throw new InvalidLibraryStatus('invalid status shelf page');
    }
    const [key, type] = keys[sort], direction = order === 'asc' ? 'ASC' : 'DESC';
    const compare = order === 'asc' ? '>' : '<';
    // Restrict the first scan to nonnull values so either index direction can
    // serve LIMIT without a sort over the whole shelf. Then enter the null tail.
    // https://www.postgresql.org/docs/current/indexes-ordering.html
    const found: Array<Row & { sort_value: string | null }> = [];
    if (!after || after.value !== null) {
      const boundary = after ? `AND (${key},work) ${compare} ($4::${type},$5::text)` : '';
      const rows = await this.pool.query<Row & { sort_value: string | null }>(`
        SELECT ${columns}, (${key})::text AS sort_value FROM reader.library_status AS shelf
        WHERE agent = $1 AND status = $2 AND ${key} IS NOT NULL ${boundary}
        ORDER BY ${key} ${direction}, work ${direction} LIMIT $3`,
      [agent, status, limit, ...(after ? [after.value, after.work] : [])]);
      found.push(...rows.rows);
    }
    if (found.length < limit && sort !== 'added') {
      const nullBoundary = after?.value === null ? `AND work ${compare} $4::text` : '';
      const rows = await this.pool.query<Row & { sort_value: string | null }>(`
        SELECT ${columns}, NULL::text AS sort_value FROM reader.library_status AS shelf
        WHERE agent = $1 AND status = $2 AND ${key} IS NULL ${nullBoundary}
        ORDER BY work ${direction} LIMIT $3`,
      [agent, status, limit - found.length, ...(after?.value === null ? [after.work] : [])]);
      found.push(...rows.rows);
    }
    return found.map(row => ({ ...state(row.work, row), sortValue: row.sort_value }));
  }

  // Continue preview uses the same indexed added order, without a shelf cursor.
  async page(agent: string, status: ReadingStatus, limit: number,
    after?: { work: string; changedAt: string }): Promise<StatusState[]> {
    return (await this.sortedPage(agent, status, limit, 'added', 'desc',
      after ? { work: after.work, value: after.changedAt } : undefined))
      .map(({ sortValue: _sortValue, ...row }) => row);
  }

  async projectRating(agent: string, work: string, value: number | null) {
    if (!ID.test(agent) || !ID.test(work) || value !== null && (!Number.isInteger(value) || value < 1 || value > 5)) {
      throw new InvalidLibraryStatus('invalid shelf rating');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [JSON.stringify(['library-status-work', agent, work])]);
      // Replays and delayed completions must not project an older receipt's value.
      const metadata = await metadataReaders.get(this.pool)?.(agent, work, client);
      const current = metadata ? metadata.ownRating : value;
      await client.query(`UPDATE reader.library_status SET own_rating = $3
        WHERE agent = $1 AND work = $2 AND own_rating IS DISTINCT FROM $3`, [agent, work, current]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  /** An owner composing this command may supply its Content transaction. It
   * owns commit/rollback; status validation, CAS and receipts remain here. */
  async write(input: StatusCommand, transaction?: PoolClient): Promise<StatusState & { replayed: boolean }> {
    const result = await this.writeStatus(input,transaction);
    // Content has committed and released its connection before cross-owner
    // delivery. Supplied transactions are recovered from their standing slots.
    if (!transaction) {
      try { await followWriters.get(this.pool)?.(input.agent,input.work); }
      catch (error) { console.warn('Library follow deferred to recovery', error); }
    }
    return result;
  }

  private async writeStatus(input: StatusCommand, transaction?: PoolClient): Promise<StatusState & { replayed: boolean }> {
    if (!ID.test(input.agent) || !ID.test(input.work) || !KEY.test(input.idempotencyKey)
      || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0
      || ![null, 'want-to-read', 'reading', 'read'].includes(input.status)
      || input.startedOn !== undefined && !validDate(input.startedOn)
      || input.finishedOn !== undefined && !validDate(input.finishedOn)
      || input.sessionProjection !== undefined && (!transaction || !ID.test(input.sessionProjection))) {
      throw new InvalidLibraryStatus('invalid status command');
    }
    // Full-form requests retain the historical bytes so old receipts replay.
    // A keep marker cannot collide with a date or an explicit null (clear).
    const intent = [input.work, input.status,
      input.startedOn === undefined ? ['keep'] : input.startedOn,
      input.finishedOn === undefined ? ['keep'] : input.finishedOn, input.expectedVersion];
    if (input.sessionProjection) intent.push(['session', input.sessionProjection]);
    const digest = createHash('sha256').update(JSON.stringify(intent)).digest('hex');
    const client = transaction ?? await this.pool.connect();
    try {
      if (!transaction) await client.query('BEGIN');
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
        if (!transaction) await client.query('COMMIT');
        return { ...prior.rows[0].result, replayed: true };
      }
      const metadata = input.shelfMetadata ?? await metadataReaders.get(this.pool)?.(input.agent, input.work, client);
      const current = await client.query<Row>(`SELECT ${columns} FROM reader.library_status
        WHERE agent = $1 AND work = $2 FOR UPDATE`, [input.agent, input.work]);
      const version = Number(current.rows[0]?.version ?? 0);
      if (version !== input.expectedVersion) throw new StaleLibraryStatus('status changed');
      const startedOn = input.startedOn === undefined ? current.rows[0]?.started_on ?? null : input.startedOn;
      const finishedOn = input.finishedOn === undefined ? current.rows[0]?.finished_on ?? null : input.finishedOn;
      if (!validDate(startedOn) || !validDate(finishedOn)
        || startedOn !== null && finishedOn !== null && startedOn > finishedOn) {
        throw new InvalidLibraryStatus('invalid reading dates');
      }
      // A standalone statement detaches this slot from its attempt; the
      // attempt's history remains unchanged under its own version check.
      const written = await client.query<Row>(`INSERT INTO reader.library_status
        (agent, work, status, started_on, finished_on, version, session_projection, title_key, own_rating, last_read_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (agent, work) DO UPDATE SET status = EXCLUDED.status,
          started_on = EXCLUDED.started_on, finished_on = EXCLUDED.finished_on,
          version = EXCLUDED.version, session_projection = EXCLUDED.session_projection, changed_at = clock_timestamp(),
          title_key = CASE WHEN $11 OR $12 THEN EXCLUDED.title_key ELSE reader.library_status.title_key END,
          own_rating = CASE WHEN $11 THEN EXCLUDED.own_rating ELSE reader.library_status.own_rating END,
          last_read_at = CASE WHEN $11 THEN EXCLUDED.last_read_at ELSE reader.library_status.last_read_at END
        RETURNING ${columns}`, [input.agent, input.work, input.status, startedOn,
        finishedOn, version + 1, input.sessionProjection ?? null, input.titleKey?.normalize('NFKC').toLowerCase() ?? metadata?.titleKey ?? null,
        metadata?.ownRating ?? null, metadata?.lastReadAt ?? null, !!metadata, input.titleKey !== undefined]);
      const result = state(input.work, written.rows[0]);
      await client.query(`INSERT INTO reader.library_status_command
        (agent, idempotency_key, request_digest, result) VALUES ($1,$2,$3,$4)`,
      [input.agent, input.idempotencyKey, digest, JSON.stringify(result)]);
      if (!transaction) await client.query('COMMIT');
      return { ...result, replayed: false };
    } catch (error) {
      if (!transaction) await client.query('ROLLBACK');
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
        throw new StaleLibraryStatus('status changed concurrently');
      }
      throw error;
    } finally { if (!transaction) client.release(); }
  }
}
