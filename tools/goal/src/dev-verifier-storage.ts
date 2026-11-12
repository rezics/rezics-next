import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { Database as SqliteDatabase } from 'bun:sqlite';
import { defaultPolicy } from './policy.ts';
import { ensureFlow, recordFlowInTransaction, type FlowEvent } from './flow.ts';
import type { DevVerifierEvidence, DevVerifierFinding, DevVerifierRun } from './types.ts';

/** The verifier persistence surface supplied by the store, with SQLite as its existing fallback. */
export type DevVerifierStorage = {
  db?: Database;
  devVerifierRun?: (key: string) => DevVerifierRun | undefined;
  devVerifierCommandRun?: (cacheKey: string) => DevVerifierRun | undefined;
  devVerifierCommandRuns?: () => DevVerifierRun[];
  devVerifierLatestRound?: () => DevVerifierRun | undefined;
  saveDevVerifierRun?: (run: DevVerifierRun) => void;
  devVerifierFindings?: (limit?: number) => DevVerifierFinding[];
  saveDevVerifierFinding?: (finding: DevVerifierFinding) => void;
};

export type CommandRunStart = { run: DevVerifierRun; claimed: boolean };

export function verifierCommandRunKey(id: string): string {
  return 'dev-verifier-command:' + id;
}

export function verifierCommandFlowEvent(run: DevVerifierRun): FlowEvent {
  const execution = run.execution!;
  return {
    taskId: 'dev-verifier-round:' + execution.roundId,
    attempt: 1,
    stage: 'check',
    action: 'command-completed',
    at: execution.completedAt!,
    operationId: execution.id,
    detail: JSON.stringify({
      executionId: execution.id,
      roundId: execution.roundId,
      commit: run.evidence.commit,
      command: run.evidence.command,
      result: execution.outcome,
      startedAt: execution.startedAt ?? null,
      completedAt: execution.completedAt,
      durationMs: execution.durationMs,
    }),
  };
}

function databaseRun(store: DevVerifierStorage, key: string): DevVerifierRun | undefined {
  const fromStore = store.devVerifierRun?.(key);
  if (fromStore) return fromStore;
  const row = store.db?.query('SELECT body FROM dev_verifier_runs WHERE cache_key=?').get(key) as
    | { body: string }
    | undefined;
  return row ? (JSON.parse(row.body) as DevVerifierRun) : undefined;
}

/** Claim the stable identity for one command attempt before its process starts. */
export function beginCommandRun(
  store: DevVerifierStorage,
  run: DevVerifierRun,
): CommandRunStart {
  if (!store.db) {
    const existing = store.devVerifierRun?.(run.key);
    if (existing) return { run: existing, claimed: false };
    store.saveDevVerifierRun?.(run);
    return { run, claimed: true };
  }

  ensureFlow(store.db);
  return store.db
    .transaction(() => {
      const existing = databaseRun(store, run.key);
      if (existing) return { run: existing, claimed: false };
      const inserted = store.db!
        .query('INSERT OR IGNORE INTO dev_verifier_runs VALUES (?,?,?)')
        .run(run.key, run.createdAt, JSON.stringify(run));
      return { run: databaseRun(store, run.key) ?? run, claimed: inserted.changes === 1 };
    })
    .immediate();
}

/** Return the first terminal receipt for an execution and its matching flow event, committed together. */
export function completeCommandRun(
  store: DevVerifierStorage,
  run: DevVerifierRun,
  policy = defaultPolicy.verifier,
): DevVerifierRun {
  if (run.execution?.status !== 'terminal') throw new Error('Verifier command completion requires a terminal receipt.');
  const event = verifierCommandFlowEvent(run);
  if (!store.db) {
    const existing = store.devVerifierRun?.(run.key);
    if (existing?.execution?.status === 'terminal') return existing;
    store.saveDevVerifierRun?.(run);
    return run;
  }

  ensureFlow(store.db);
  return store.db
    .transaction(() => {
      const existing = databaseRun(store, run.key);
      if (existing?.execution?.status === 'terminal') return existing;
      const completed = existing ? { ...run, createdAt: existing.createdAt } : run;
      store.db!
        .query('INSERT OR REPLACE INTO dev_verifier_runs VALUES (?,?,?)')
        .run(completed.key, completed.createdAt, JSON.stringify(completed));
      recordFlowInTransaction(store.db!, event);
      store.db!
        .query(
          'DELETE FROM dev_verifier_runs WHERE cache_key IN (SELECT cache_key FROM dev_verifier_runs ORDER BY rowid DESC LIMIT -1 OFFSET ?)',
        )
        .run(policy.runRows);
      return completed;
    })
    .immediate();
}

export function commandRunById(store: DevVerifierStorage, id: string): DevVerifierRun | undefined {
  return databaseRun(store, verifierCommandRunKey(id));
}

/** Find the newest durable receipt for this exact cache identity; older bare cache rows remain unreceipted. */
export function latestCommandRun(
  store: DevVerifierStorage,
  cacheKey: string,
): DevVerifierRun | undefined {
  const fromStore = store.devVerifierCommandRun?.(cacheKey);
  if (fromStore?.execution?.status === 'terminal') return fromStore;
  if (!store.db) {
    return store
      .devVerifierCommandRuns?.()
      .find((run) => run.execution?.cacheKey === cacheKey && run.execution.status === 'terminal');
  }
  const rows = store.db
    .query("SELECT body FROM dev_verifier_runs WHERE cache_key LIKE 'dev-verifier-command:%' ORDER BY rowid DESC")
    .all() as { body: string }[];
  for (const row of rows) {
    const run = JSON.parse(row.body) as DevVerifierRun;
    if (run.execution?.cacheKey === cacheKey && run.execution.status === 'terminal') return run;
  }
  return undefined;
}

export function latestRound(store: DevVerifierStorage): DevVerifierRun | undefined {
  try {
    if (store.devVerifierLatestRound) return store.devVerifierLatestRound();
    const row = store.db
      ?.query(
        "SELECT body FROM dev_verifier_runs WHERE cache_key LIKE 'dev-verifier-round:%' ORDER BY rowid DESC LIMIT 1",
      )
      .get() as { body: string } | undefined;
    const run = row ? (JSON.parse(row.body) as DevVerifierRun) : undefined;
    return run?.round ? run : undefined;
  } catch {
    return undefined;
  }
}

export function cachedRun(store: DevVerifierStorage, key: string): DevVerifierEvidence | undefined {
  try {
    const run = store.devVerifierRun?.(key);
    if (run) return run.evidence;
    if (!store.db) return undefined;
    const row = store.db.query('SELECT body FROM dev_verifier_runs WHERE cache_key=?').get(key) as
      | { body: string }
      | undefined;
    return row ? (JSON.parse(row.body) as DevVerifierRun).evidence : undefined;
  } catch {
    return undefined;
  }
}

export function saveRun(store: DevVerifierStorage, run: DevVerifierRun, policy = defaultPolicy.verifier): void {
  try {
    if (store.saveDevVerifierRun) {
      store.saveDevVerifierRun(run);
      return;
    }
    if (!store.db) return;
    store.db
      .query('INSERT OR REPLACE INTO dev_verifier_runs VALUES (?,?,?)')
      .run(run.key, run.createdAt, JSON.stringify(run));
    store.db
      .query(
        `DELETE FROM dev_verifier_runs WHERE cache_key IN (SELECT cache_key FROM dev_verifier_runs ORDER BY rowid DESC LIMIT -1 OFFSET ${policy.runRows})`,
      )
      .run();
  } catch {
    // A failed cache write cannot change the fresh gate result.
  }
}

export function saveFinding(
  store: DevVerifierStorage,
  finding: DevVerifierFinding,
  policy = defaultPolicy.verifier,
): void {
  try {
    if (store.saveDevVerifierFinding) {
      store.saveDevVerifierFinding(finding);
      return;
    }
    if (!store.db) return;
    store.db
      .query('INSERT OR REPLACE INTO dev_verifier_findings VALUES (?,?,?,?,?,?,?,?)')
      .run(
        finding.rangeKey,
        finding.identity,
        finding.signature,
        finding.baseCommit,
        finding.headCommit,
        finding.status,
        finding.createdAt,
        JSON.stringify(finding),
      );
    store.db
      .query(
        `DELETE FROM dev_verifier_findings WHERE range_key IN (SELECT range_key FROM dev_verifier_findings ORDER BY rowid DESC LIMIT -1 OFFSET ${policy.findingRows})`,
      )
      .run();
  } catch {
    // Findings are durable when the store is available, but persistence failure does not rewrite check outcomes.
  }
}

export type VerificationFindingCounts = { existing: number; new: number; unknown: number };

export function readFindingCounts(stateDirectory: string | undefined): VerificationFindingCounts {
  const empty = { existing: 0, new: 0, unknown: 0 };
  if (!stateDirectory) return empty;
  const path = join(stateDirectory, 'goal.sqlite');
  if (!existsSync(path)) return empty;
  let db: Database | undefined;
  try {
    db = new SqliteDatabase(path, { readonly: true, create: false });
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dev_verifier_findings'").get())
      return empty;
    const counts = db.query('SELECT status, count(*) AS count FROM dev_verifier_findings GROUP BY status').all() as {
      status: string;
      count: number;
    }[];
    const result = { ...empty };
    for (const row of counts)
      if (row.status in result) result[row.status as keyof VerificationFindingCounts] = row.count;
    return result;
  } catch {
    return empty;
  } finally {
    db?.close();
  }
}
