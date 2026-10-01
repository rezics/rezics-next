import type { Pool } from 'pg';

const WORK = /^OL[1-9][0-9]{0,11}W$/;
const AGENT = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
export const READER_IMPORT_COST = { sourceSearchesPerDay: 200, acquisitionsPerDay: 50,
  sourceBindings: 2, batchRows: 5_000, rowsPerRequest: 8,
  shelvesPerRow: 20, reviewCharacters: 8_000 } as const;
export class ReaderImportBudgetExceeded extends Error {
  constructor(readonly kind: 'search' | 'acquisition') { super(`reader import ${kind} budget exceeded`); }
}
export class ReaderImportUnavailable extends Error {}
export class ReaderImportConflict extends Error {}
export class ReaderImportInvalid extends Error {}
export interface ImportPlacement { structure: string; expectedHead: string; attempt: number;
  completed: boolean }

/** The source record is site-wide. A session lock serializes this route's
 * read-before-acquire path for one Open Library identity across readers. */
export class ReaderLibraryImportStore {
  constructor(private readonly pool: Pool, private readonly budgets = {
    sourceSearchesPerDay: READER_IMPORT_COST.sourceSearchesPerDay as number,
    acquisitionsPerDay: READER_IMPORT_COST.acquisitionsPerDay as number,
  }) {
    if (Object.values(budgets).some(value => !Number.isSafeInteger(value) || value < 1 || value > 1_000_000)) {
      throw new Error('Invalid Library import daily budgets');
    }
  }
  private dispatch: ((request: Request) => Promise<Response>) | null = null;

  setDispatch(dispatch: (request: Request) => Promise<Response>): void {
    this.dispatch = dispatch;
  }

  async call(request: Request): Promise<Response> {
    if (!this.dispatch) throw new ReaderImportUnavailable('Main import dispatcher is unavailable');
    return this.dispatch(request);
  }

  /** The batch key binds one complete reviewed intent. A retry resumes its
   * first unfinished row; completed outcomes remain immutable. */
  async beginBatch(agent: string, key: string, digest: string, count: number): Promise<void> {
    if (!AGENT.test(agent) || !/^[A-Za-z0-9:_./-]{1,128}$/.test(key)
      || !/^[0-9a-f]{64}$/.test(digest) || count < 1 || count > READER_IMPORT_COST.batchRows) {
      throw new ReaderImportInvalid('invalid Library import batch');
    }
    await this.pool.query(`INSERT INTO reader.library_import_batch (agent, import_key, request_digest, row_count)
      VALUES ($1,$2,$3,$4) ON CONFLICT (agent, import_key) DO NOTHING`, [agent, key, digest, count]);
    const existing = await this.pool.query<{ request_digest: string; row_count: number }>(`
      SELECT request_digest, row_count FROM reader.library_import_batch WHERE agent = $1 AND import_key = $2`,
    [agent, key]);
    if (existing.rows[0]?.request_digest !== digest || existing.rows[0]?.row_count !== count) {
      throw new ReaderImportConflict('Library import key changed intent');
    }
  }

  async outcomes(agent: string, key: string): Promise<Map<number, unknown>> {
    const found = await this.pool.query<{ row_number: number; outcome: unknown }>(`
      SELECT row_number, outcome FROM reader.library_import_row_outcome
      WHERE agent = $1 AND import_key = $2 ORDER BY row_number LIMIT ${READER_IMPORT_COST.batchRows + 1}`,
    [agent, key]);
    if (found.rows.length > READER_IMPORT_COST.batchRows) {
      throw new ReaderImportUnavailable('Library import result exceeds budget');
    }
    return new Map(found.rows.map(row => [row.row_number, row.outcome]));
  }

  async recordOutcome(agent: string, key: string, row: number, outcome: object): Promise<void> {
    await this.pool.query(`INSERT INTO reader.library_import_row_outcome
      (agent, import_key, row_number, outcome) VALUES ($1,$2,$3,$4)
      ON CONFLICT (agent, import_key, row_number) DO NOTHING`, [agent, key, row, JSON.stringify(outcome)]);
  }

  async planStep(agent: string, key: string, row: number, step: string, plan: object): Promise<{
    plan: Record<string, unknown>; completed: boolean }> {
    await this.pool.query(`INSERT INTO reader.library_import_step (agent, import_key, row_number, step_key, plan)
      VALUES ($1,$2,$3,$4,$5) ON CONFLICT (agent, import_key, row_number, step_key) DO NOTHING`,
    [agent, key, row, step, JSON.stringify(plan)]);
    const found = await this.pool.query<{ plan: Record<string, unknown>; completed: boolean }>(`
      SELECT plan, completed FROM reader.library_import_step
      WHERE agent = $1 AND import_key = $2 AND row_number = $3 AND step_key = $4`,
    [agent, key, row, step]);
    if (!found.rows[0]) throw new ReaderImportUnavailable('Library import step is unavailable');
    return found.rows[0];
  }

  async completeStep(agent: string, key: string, row: number, step: string): Promise<void> {
    await this.pool.query(`UPDATE reader.library_import_step SET completed = true
      WHERE agent = $1 AND import_key = $2 AND row_number = $3 AND step_key = $4`,
    [agent, key, row, step]);
  }

  async planPlacement(agent: string, shelf: string, work: string,
    structure: string, expectedHead: string): Promise<ImportPlacement> {
    await this.pool.query(`INSERT INTO reader.library_import_placement
      (agent, shelf, work, structure, expected_head) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (agent, shelf, work) DO NOTHING`, [agent, shelf, work, structure, expectedHead]);
    const found = await this.pool.query<{ structure: string; expected_head: string; attempt: number;
      completed: boolean }>(`SELECT structure, expected_head, attempt, completed
      FROM reader.library_import_placement WHERE agent = $1 AND shelf = $2 AND work = $3`,
    [agent, shelf, work]);
    if (!found.rows[0]) throw new ReaderImportUnavailable('Library shelf placement is unavailable');
    const row = found.rows[0];
    return { structure: row.structure, expectedHead: row.expected_head,
      attempt: row.attempt, completed: row.completed };
  }

  async completePlacement(agent: string, shelf: string, work: string): Promise<void> {
    await this.pool.query(`UPDATE reader.library_import_placement SET completed = true
      WHERE agent = $1 AND shelf = $2 AND work = $3`, [agent, shelf, work]);
  }

  async revisePlacement(agent: string, shelf: string, work: string,
    current: ImportPlacement, structure: string, expectedHead: string): Promise<void> {
    if (current.attempt >= 4) throw new ReaderImportUnavailable('Library shelf changed repeatedly');
    await this.pool.query(`UPDATE reader.library_import_placement
      SET structure = $4, expected_head = $5, attempt = attempt + 1
      WHERE agent = $1 AND shelf = $2 AND work = $3 AND completed = false
        AND attempt = $6 AND expected_head = $7`,
    [agent, shelf, work, structure, expectedHead, current.attempt, current.expectedHead]);
  }

  async withBatch<T>(agent: string, key: string, action: () => Promise<T>): Promise<T | null> {
    const client = await this.pool.connect();
    const lock = `reader-library-import:${agent}:${key}`;
    let held = false;
    try {
      held = (await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [lock])).rows[0]?.locked ?? false;
      return held ? await action() : null;
    } finally {
      if (held) await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lock]);
      client.release();
    }
  }

  async withOpenLibraryWork<T>(workId: string, action: () => Promise<T>): Promise<T> {
    if (!WORK.test(workId)) throw new ReaderImportUnavailable('invalid Open Library Work');
    const client = await this.pool.connect();
    const lock = `reader-open-library-work:${workId}`;
    let held = false;
    try {
      // A concurrent reader waits for the first adoption and then sees its
      // source binding. The lock is released on connection loss as well.
      await client.query("SET statement_timeout = '30s'");
      await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lock]);
      held = true;
      await client.query('SET statement_timeout = 0');
      return await action();
    } catch (error) {
      if ((error as { code?: string }).code === '57014') {
        throw new ReaderImportUnavailable('Open Library Work addition is still pending');
      }
      throw error;
    } finally {
      try {
        if (held) await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lock]);
      } finally {
        await client.query('RESET statement_timeout').catch(() => {});
        client.release();
      }
    }
  }

  /** A retained source binding, irrespective of its original reader, supplies
   * the canonical native Work. Multiple earlier bindings are refused. */
  async adoptedOpenLibraryWork(workId: string): Promise<string | null> {
    if (!WORK.test(workId)) throw new ReaderImportUnavailable('invalid Open Library Work');
    const rows = await this.pool.query<{ work: string }>(`
      SELECT DISTINCT b.work FROM source.record r
      JOIN source.observation o ON o.record_id = r.id
      JOIN source.native_work_proposal p ON p.observation_id = o.id
      JOIN source.native_work_binding b ON b.proposal_id = p.id
      WHERE r.provider = 'open-library' AND r.namespace = 'work' AND r.external_id = $1
      LIMIT ${READER_IMPORT_COST.sourceBindings}`, [workId]);
    if (rows.rows.length > 1) throw new ReaderImportUnavailable('Open Library Work has multiple native bindings');
    return rows.rows[0]?.work ?? null;
  }

  async takeBudget(agent: string, kind: 'search' | 'acquisition', now = new Date()): Promise<void> {
    if (!AGENT.test(agent)) throw new ReaderImportUnavailable('invalid reader');
    const day = now.toISOString().slice(0, 10);
    const column = kind === 'search' ? 'searches' : 'acquisitions';
    const limit = kind === 'search' ? this.budgets.sourceSearchesPerDay : this.budgets.acquisitionsPerDay;
    const rows = await this.pool.query<{ agent: string }>(`
      INSERT INTO reader.library_import_daily_budget (agent, day, ${column}) VALUES ($1,$2,1)
      ON CONFLICT (agent, day) DO UPDATE SET ${column} = reader.library_import_daily_budget.${column} + 1
      WHERE reader.library_import_daily_budget.${column} < $3
      RETURNING agent`, [agent, day, limit]);
    if (!rows.rowCount) throw new ReaderImportBudgetExceeded(kind);
  }
}
