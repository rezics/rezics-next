import { canonicalChapterWorks } from '../structure/chapter-work.ts';
import { resolveTargets } from '../target/resolve.ts';
import type { WorkReadSession } from '../work/read-session.ts';

/** Library state belongs to the Book. Resolve its identity only after the
 * bounded chapter lookup; every Book merge hop still needs live disclosure. */
export async function resolveLibraryWork(session: WorkReadSession, work: string) {
  return (await resolveLibraryWorks(session, [work]))[0]!;
}

export async function resolveLibraryWorks(session: WorkReadSession, works: string[]) {
  const parents = await canonicalChapterWorks(session, works);
  return (
    await resolveTargets(
      session,
      works.map((work) => parents.get(work) ?? work),
      'library-status',
    )
  ).map((target) => target.resource);
}
