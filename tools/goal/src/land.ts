import type { Database } from 'bun:sqlite';
import type { AttemptFence, LandingQueue, LandingRequest, GateOutcome } from './contracts.ts';
import type { GateResult } from './merge.ts';
import { migrate } from './db.ts';

export type LandingEntry = {
  id: number;
  request: LandingRequest;
  outcome: GateOutcome | null;
  delivered: number;
  candidate: string | null;
};

/** Requests and outcomes survive a train restart. Sink delivery is at least once. */
export class SqliteLandingQueue implements LandingQueue {
  constructor(
    readonly db: Database,
    private readonly fence: AttemptFence,
  ) {
    migrate(db, [
      {
        module: 'landing',
        version: 1,
        sql: `
      CREATE TABLE landing_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT NOT NULL, attempt INTEGER NOT NULL,
        request TEXT NOT NULL, outcome TEXT, delivered INTEGER NOT NULL DEFAULT 0, candidate TEXT,
        UNIQUE(task, attempt)
      );`,
      },
      {
        module: 'landing',
        version: 2,
        sql: `
      CREATE TABLE landing_baselines (main_commit TEXT NOT NULL, gate_command TEXT NOT NULL, result TEXT NOT NULL,
        PRIMARY KEY(main_commit, gate_command));`,
      },
    ]);
  }
  enqueue(request: LandingRequest): void {
    this.db
      .transaction(() => {
        this.fence.assertCurrent(request);
        this.db
          .query(
            'INSERT INTO landing_queue(task, attempt, request) VALUES (?, ?, ?) ON CONFLICT(task, attempt) DO NOTHING',
          )
          .run(request.taskId, request.attempt, JSON.stringify(request));
      })
      .immediate();
  }
  baseline(commit: string, command: string): GateResult | undefined {
    const row = this.db
      .query('SELECT result FROM landing_baselines WHERE main_commit=? AND gate_command=?')
      .get(commit, command) as { result: string } | null;
    return row ? JSON.parse(row.result) : undefined;
  }
  saveBaseline(commit: string, command: string, result: GateResult): void {
    this.db
      .query('INSERT OR REPLACE INTO landing_baselines VALUES (?,?,?)')
      .run(commit, command, JSON.stringify(result));
  }
  next(): LandingEntry | undefined {
    return this.nextBatch(1)[0];
  }
  nextBatch(limit: number, excludedIds: readonly number[] = [], lane?: 'main' | 'dev'): LandingEntry[] {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('landing batch size must be a positive integer');
    // Control-plane changes land first, since they change how fast everything else lands; then critical-path and
    // stabilize fixes, which unblock other work (a fix for dev's red typecheck once waited behind 37 landings).
    const tasks = this.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'worker_tasks'").get();
    const laneFilter = lane
      ? !tasks
        ? lane === 'main'
          ? ' AND 0'
          : ''
        : lane === 'main'
          ? ` AND (
            COALESCE(json_extract((SELECT body FROM worker_tasks WHERE id = task), '$.brief.target'), '') = 'main'
            OR (
              json_extract((SELECT body FROM worker_tasks WHERE id = task), '$.brief.goal') = 'control-plane'
              AND COALESCE(json_extract((SELECT body FROM worker_tasks WHERE id = task), '$.brief.target'), '') != 'stabilize'
              AND json_array_length(request, '$.declaredPaths') > 0
              AND NOT EXISTS (
                SELECT 1 FROM json_each(request, '$.declaredPaths')
                WHERE value NOT GLOB 'tools/goal/*'
              )
            )
          )`
          : ` AND NOT (
            COALESCE(json_extract((SELECT body FROM worker_tasks WHERE id = task), '$.brief.target'), '') = 'main'
            OR (
              json_extract((SELECT body FROM worker_tasks WHERE id = task), '$.brief.goal') = 'control-plane'
              AND COALESCE(json_extract((SELECT body FROM worker_tasks WHERE id = task), '$.brief.target'), '') != 'stabilize'
              AND json_array_length(request, '$.declaredPaths') > 0
              AND NOT EXISTS (
                SELECT 1 FROM json_each(request, '$.declaredPaths')
                WHERE value NOT GLOB 'tools/goal/*'
              )
            )
          )`
      : '';
    const priority = tasks
      ? "COALESCE((SELECT json_extract(body, '$.brief.goal') = 'control-plane' FROM worker_tasks WHERE id = task), 0) DESC, " +
        "COALESCE((SELECT json_extract(body, '$.brief.criticalPath') = 1 OR json_extract(body, '$.brief.target') = 'stabilize' FROM worker_tasks WHERE id = task), 0) DESC, "
      : '';
    const excluded = excludedIds.length ? ` AND id NOT IN (${excludedIds.map(() => '?').join(',')})` : '';
    const rows = this.db
      .query(`SELECT * FROM landing_queue WHERE delivered = 0${laneFilter}${excluded} ORDER BY ${priority}id LIMIT ?`)
      .all(...excludedIds, limit) as {
      id: number;
      request: string;
      outcome: string | null;
      delivered: number;
      candidate: string | null;
    }[];
    return rows.map((row) => ({
      ...row,
      request: JSON.parse(row.request),
      outcome: row.outcome ? JSON.parse(row.outcome) : null,
    }));
  }
  candidate(id: number, commit: string): void {
    this.db.query('UPDATE landing_queue SET candidate = ? WHERE id = ?').run(commit, id);
  }
  finish(id: number, outcome: GateOutcome): void {
    this.db.query('UPDATE landing_queue SET outcome = ? WHERE id = ?').run(JSON.stringify(outcome), id);
  }
  acknowledge(id: number): void {
    this.db.query('UPDATE landing_queue SET delivered = 1 WHERE id = ?').run(id);
  }
}
