import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { Database as SqliteDatabase } from 'bun:sqlite';
import { defaultPolicy } from './policy.ts';
import type { DevVerifierEvidence, DevVerifierFinding, DevVerifierRun } from './types.ts';

/** The verifier persistence surface supplied by the store, with SQLite as its existing fallback. */
export type DevVerifierStorage = {
  db?: Database;
  devVerifierRun?: (key: string) => DevVerifierRun | undefined;
  devVerifierLatestRound?: () => DevVerifierRun | undefined;
  saveDevVerifierRun?: (run: DevVerifierRun) => void;
  devVerifierFindings?: (limit?: number) => DevVerifierFinding[];
  saveDevVerifierFinding?: (finding: DevVerifierFinding) => void;
};

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
