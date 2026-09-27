import { WorkReadMoved, type WorkReadSession } from '../work/read-session.ts';
import type { AuthorName } from './author-name.ts';

const reads = new WeakMap<WorkReadSession, Map<string, AuthorName | null>>();

/** Current source facts are read once per page, not copied into discovery's
 * projection. A final fence covers refresh/removal during any Work read. */
export async function readAuthorNames(session: WorkReadSession, keys: readonly string[]) {
  const selected = [...new Set(keys)];
  const names = await session.deps.sourceAuthorNames?.batch(selected) ?? new Map<string, AuthorName>();
  const prior = reads.get(session) ?? new Map<string, AuthorName | null>();
  for (const key of selected) {
    const value = names.get(key) ?? null;
    if (prior.has(key) && JSON.stringify(prior.get(key)) !== JSON.stringify(value)) {
      throw new WorkReadMoved('Source author names changed during the read');
    }
    prior.set(key, value);
  }
  reads.set(session, prior);
  session.checkDeadline();
  return names;
}

export async function fenceAuthorNames(session: WorkReadSession) {
  const prior = reads.get(session);
  if (prior?.size) await readAuthorNames(session, [...prior.keys()]);
}
