import { resolveTargets } from '../target/resolve.ts';
import type { WorkReadSession } from '../work/read-session.ts';

/** Library state belongs to an independently identified Work. */
export async function resolveLibraryWork(session: WorkReadSession, work: string) {
  return (await resolveLibraryWorks(session, [work]))[0]!;
}

export async function resolveLibraryWorks(session: WorkReadSession, works: string[]) {
  return (
    await resolveTargets(
      session,
      works,
      'library-status',
    )
  ).map((target) => target.resource);
}
