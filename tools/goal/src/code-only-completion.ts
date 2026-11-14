import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDb } from './db.ts';
import { SqliteManagerInbox } from './inbox.ts';
import { loadSettings } from './settings.ts';

type CodeOnlyCompletion = { id: string; manager: string; goal: string };

/** System observation of an original launch; never a manager send, task result or acceptance. */
export function deliverCodeOnlyCompletion(path: string, settings = loadSettings()) {
  const evidencePath = resolve(path);
  const completion = JSON.parse(readFileSync(evidencePath, 'utf8')) as CodeOnlyCompletion;
  const db = openDb(join(settings.stateDirectory, 'goal.sqlite'), settings.policy.storage);
  try {
    // The native commit must survive a host restart before Python saves its local delivery marker.
    db.exec('PRAGMA synchronous = FULL');
    const inbox = new SqliteManagerInbox(db, settings.integration.inboxDirectory, undefined, settings.policy.inbox);
    // Keep this identity independent of source failures, execution updates and recovery attempts.
    // JSON quoting keeps launch labels on one line, matching the native first-line delivery key.
    const summary = `Code-only completion ${JSON.stringify(completion.id)}. Retained source and worker final/next-outcome handoff; review and refill independent work. Integration and acceptance remain deferred.`;
    const key = createHash('sha256')
      .update(JSON.stringify([completion.manager, 'handoff', 'system:code-only', null, null, summary]))
      .digest('hex');
    return db.transaction(() => {
      const find = () => db.query(
        'SELECT id FROM manager_inbox WHERE dedupe_key = ? ORDER BY created_at DESC, id DESC LIMIT 1',
      ).get(key) as { id: number } | null;
      // No time window: a committed native row resolves a restart before the local marker,
      // even after the ordinary inbox fold has expired or the manager has consumed the message.
      const existing = find();
      if (existing) return { id: existing.id, reused: true };
      inbox.deliver({ managerId: completion.manager, kind: 'handoff', from: 'system:code-only',
        goalId: completion.goal, summary, evidencePath });
      const row = find();
      if (!row) throw new Error('code-only handoff did not create a native inbox row');
      return { id: row.id, reused: false };
    }).immediate();
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  console.log(JSON.stringify(deliverCodeOnlyCompletion(process.argv[2]!)));
}
