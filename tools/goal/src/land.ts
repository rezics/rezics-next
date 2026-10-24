import type { Database } from 'bun:sqlite';
import type { AttemptFence, LandingQueue, LandingRequest, GateOutcome } from './contracts.ts';
import { migrate } from './db.ts';

export type LandingEntry = { id: number; request: LandingRequest; outcome: GateOutcome | null; delivered: number; candidate: string | null };

/** Requests and outcomes survive a train restart. Sink delivery is at least once. */
export class SqliteLandingQueue implements LandingQueue {
  constructor(readonly db: Database, private readonly fence: AttemptFence) {
    migrate(db, [{ module: 'landing', version: 1, sql: `
      CREATE TABLE landing_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT NOT NULL, attempt INTEGER NOT NULL,
        request TEXT NOT NULL, outcome TEXT, delivered INTEGER NOT NULL DEFAULT 0, candidate TEXT,
        UNIQUE(task, attempt)
      );` }]);
  }
  enqueue(request: LandingRequest): void {
    this.fence.assertCurrent(request);
    this.db.query('INSERT INTO landing_queue(task, attempt, request) VALUES (?, ?, ?) ON CONFLICT(task, attempt) DO NOTHING')
      .run(request.taskId, request.attempt, JSON.stringify(request));
  }
  next(): LandingEntry | undefined {
    const row = this.db.query('SELECT * FROM landing_queue WHERE delivered = 0 ORDER BY id LIMIT 1').get() as
      { id: number; request: string; outcome: string | null; delivered: number; candidate: string | null } | null;
    return row ? { ...row, request: JSON.parse(row.request), outcome: row.outcome ? JSON.parse(row.outcome) : null } : undefined;
  }
  candidate(id: number, commit: string): void {
    this.db.query('UPDATE landing_queue SET candidate = ? WHERE id = ?').run(commit, id);
  }
  finish(id: number, outcome: GateOutcome): void {
    this.db.query('UPDATE landing_queue SET outcome = ? WHERE id = ?').run(JSON.stringify(outcome), id);
  }
  acknowledge(id: number): void { this.db.query('UPDATE landing_queue SET delivered = 1 WHERE id = ?').run(id); }
}
