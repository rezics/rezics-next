import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// A pinned callback may live in a sparse source worktree before publication.
// Native state and its services still belong to the configured Main runtime.
const nativeSource = process.env.GOAL_MAIN_CHECKOUT
  ? resolve(process.env.GOAL_MAIN_CHECKOUT, 'tools/goal/src') : import.meta.dir;
const [{ openDb }, { SqliteManagerInbox }, { readManagerOwnership }, { loadSettings }] = await Promise.all([
  import(pathToFileURL(join(nativeSource, 'db.ts')).href) as Promise<typeof import('./db.ts')>,
  import(pathToFileURL(join(nativeSource, 'inbox.ts')).href) as Promise<typeof import('./inbox.ts')>,
  import(pathToFileURL(join(nativeSource, 'manager-ownership.ts')).href) as Promise<typeof import('./manager-ownership.ts')>,
  import(pathToFileURL(join(nativeSource, 'settings.ts')).href) as Promise<typeof import('./settings.ts')>,
]);

type CodeOnlyCompletion = {
  id: string;
  manager: string;
  sourceManager?: string;
  goal: string;
  source?: { classification?: string; committedSource?: boolean | null; retainedEdits?: boolean | null };
  execution?: { resultAvailable?: boolean };
};

function currentGoalOwner(db: ReturnType<typeof openDb>, goal: string, fallback: string): string {
  const owners = readManagerOwnership(db)
    .filter((manager) => manager.status === 'running' && manager.kind !== 'resident-supermanager'
      && manager.goals.includes(goal))
    .map((manager) => manager.id);
  return owners.length === 1 ? owners[0]! : fallback;
}

/** System observation of an original launch; never a manager send, task result or acceptance. */
export function deliverCodeOnlyCompletion(path: string, settings = loadSettings()) {
  const evidencePath = resolve(path);
  const completion = JSON.parse(readFileSync(evidencePath, 'utf8')) as CodeOnlyCompletion;
  const sourceManager = completion.sourceManager || completion.manager;
  const db = openDb(join(settings.stateDirectory, 'goal.sqlite'), settings.policy.storage);
  try {
    // The native commit must survive a host restart before Python saves its local delivery marker.
    db.exec('PRAGMA synchronous = FULL');
    const inbox = new SqliteManagerInbox(db, settings.integration.inboxDirectory, undefined, settings.policy.inbox);
    // The launch id prefix is the durable handoff identity across wording and owner changes.
    const sourceNames: Record<string, string> = {
      'committed-source': 'committed source',
      'retained-edits': 'retained edits',
      'committed-source-and-retained-edits': 'committed source and retained edits',
      'no-source': 'no source',
      unavailable: 'unavailable',
    };
    const sourceStatus = sourceNames[completion.source?.classification ?? 'unavailable'] ?? 'unavailable';
    const evidence = (value: boolean | null | undefined) =>
      value === true ? 'yes' : value === false ? 'no' : 'unavailable';
    const resultStatus = completion.execution?.resultAvailable === true ? 'available' : 'unavailable';
    // JSON quoting keeps launch labels on one line, matching the native first-line delivery key.
    const summary = `Code-only launch observation ${JSON.stringify(completion.id)}. Source: ${sourceStatus}; committed source: ${evidence(completion.source?.committedSource)}; retained edits: ${evidence(completion.source?.retainedEdits)}; original execution result: ${resultStatus}. Review and refill independent work. Integration and acceptance remain deferred.`;
    const keyFor = (manager: string) => createHash('sha256')
      .update(JSON.stringify([manager, 'handoff', 'system:code-only', null, null, summary]))
      .digest('hex');
    return db.transaction(() => {
      const findByKey = (key: string) => db.query(
        'SELECT id, manager FROM manager_inbox WHERE dedupe_key = ? ORDER BY created_at DESC, id DESC LIMIT 1',
      ).get(key) as { id: number; manager: string } | null;
      const completionPrefix = `Code-only launch observation ${JSON.stringify(completion.id)}.`;
      const legacyPrefix = `Code-only completion ${JSON.stringify(completion.id)}.`;
      const plainLegacyPrefix = `Code-only completion ${completion.id}.`;
      const findCompletion = () => db.query(
        `SELECT id, manager FROM manager_inbox
         WHERE sender = 'system:code-only' AND kind = 'handoff'
           AND (substr(summary, 1, ?) = ? OR substr(summary, 1, ?) = ? OR substr(summary, 1, ?) = ?)
         ORDER BY id ASC LIMIT 1`,
      ).get(completionPrefix.length, completionPrefix, legacyPrefix.length, legacyPrefix,
        plainLegacyPrefix.length, plainLegacyPrefix) as { id: number; manager: string } | null;
      // No time window: a committed native row resolves a restart before the local marker,
      // even after the ordinary inbox fold has expired or the manager has consumed the message.
      // The stable id prefix and legacy prefix resolve wording revisions and Goal transfers before retrying.
      const existing = findCompletion();
      if (existing) return { id: existing.id, recipient: existing.manager, sourceManager, reused: true };
      // This is the original recipient-scoped native dedupe identity used by earlier helpers.
      const legacy = findByKey(keyFor(completion.manager));
      if (legacy) return { id: legacy.id, recipient: legacy.manager, sourceManager, reused: true };
      const recipient = currentGoalOwner(db, completion.goal, sourceManager);
      const key = keyFor(recipient);
      const keyed = findByKey(key);
      if (keyed) return { id: keyed.id, recipient: keyed.manager, sourceManager, reused: true };
      inbox.deliver({ managerId: recipient, kind: 'handoff', from: 'system:code-only',
        goalId: completion.goal, summary, evidencePath });
      const row = findByKey(key);
      if (!row) throw new Error('code-only handoff did not create a native inbox row');
      return { id: row.id, recipient: row.manager, sourceManager, reused: false };
    }).immediate();
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  console.log(JSON.stringify(deliverCodeOnlyCompletion(process.argv[2]!)));
}
