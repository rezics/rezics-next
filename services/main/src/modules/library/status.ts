import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { WorkReadLimit } from '../work/read-session.ts';

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
export interface YearlyGoal { year: number; target: number | null; completed: number;
  version: number; changedAt: string | null; replayed?: boolean }
export const READING_STATS_COST = { finishedWorks: 240, completedOccurrences: 2400,
  sqlStatements: 2 } as const;
export interface ReadingMonth { month: number; books: number; chapters: number }
export interface ReadingYear { year: number; books: number; chapters: number; months: ReadingMonth[] }
export interface PrivateImportReview { work: string; text: string; language: string;
  spoiler: boolean; version: number; changedAt: string; replayed?: boolean }

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

  /** Dated Read statuses and first completed chapter commands are distinct counters.
   * Both inputs have explicit ceilings; the read fails instead of presenting a partial year. */
  async readingYear(agent: string, principal: VerifiedPrincipal, year: number): Promise<ReadingYear> {
    if (!ID.test(agent) || !Number.isInteger(year) || year < 1900 || year > 2100) {
      throw new InvalidLibraryStatus('invalid reading stats year');
    }
    const [books, chapters] = await Promise.all([
      this.pool.query<{ finished_on: string }>(`
        SELECT finished_on::text AS finished_on FROM reader.library_status
        WHERE agent = $1 AND status = 'read' AND finished_on >= make_date($2,1,1)
          AND finished_on < make_date($2 + 1,1,1)
        ORDER BY finished_on, work LIMIT ${READING_STATS_COST.finishedWorks + 1}`, [agent, year]),
      this.pool.query<{ completed_at: string }>(`
        SELECT created_at::text AS completed_at FROM structure.progress_command
        WHERE principal_issuer = $1 AND principal_subject = $2 AND first_finish
          AND created_at >= make_date($3,1,1) AND created_at < make_date($3 + 1,1,1)
        ORDER BY created_at, structure, occurrence
        LIMIT ${READING_STATS_COST.completedOccurrences + 1}`, [principal.issuer, principal.subject, year]),
    ]);
    if (books.rows.length > READING_STATS_COST.finishedWorks
      || chapters.rows.length > READING_STATS_COST.completedOccurrences) {
      throw new WorkReadLimit('Reading stats exceed the yearly read budget');
    }
    const months: ReadingMonth[] = Array.from({ length: 12 }, (_, index) =>
      ({ month: index + 1, books: 0, chapters: 0 }));
    for (const row of books.rows) months[Number(row.finished_on.slice(5, 7)) - 1]!.books++;
    for (const row of chapters.rows) {
      const completed = new Date(row.completed_at);
      if (completed.getUTCFullYear() === year) months[completed.getUTCMonth()]!.chapters++;
    }
    return { year, books: books.rows.length, chapters: months.reduce((total, month) => total + month.chapters, 0),
      months };
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

  /** The public projection checks every candidate against current Work disclosure.
   * Exceeding this ceiling fails closed rather than returning false counts. */
  async publicCandidates(agent: string, ceiling = 240): Promise<StatusState[]> {
    if (!ID.test(agent) || ceiling !== 240) throw new InvalidLibraryStatus('invalid public shelf budget');
    const rows = await this.pool.query<Row>(`SELECT ${columns} FROM reader.library_status
      WHERE agent = $1 AND status IS NOT NULL
      ORDER BY changed_at DESC, work DESC LIMIT $2`, [agent, ceiling + 1]);
    if (rows.rows.length > ceiling) throw new WorkReadLimit('Public shelf exceeds bounded scan');
    return rows.rows.map(row => state(row.work, row));
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
