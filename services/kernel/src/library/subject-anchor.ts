import type { Pool } from 'pg';
import { systemClock, type KernelClock } from '../clock.ts';
import { accessCheck, type Access, type Actor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { subjectReadEligibility } from '../semantic/eligibility.ts';
import { readSubject } from '../semantic/subject.ts';

const ACCESS_BUDGET_MS = 5_000;
const MAX_SUBJECT_IDS = 100;
const MAX_CONCURRENT_SUBJECT_READS = 4;

export type SubjectAnchorDependencies = {
  pool: Pool;
  access: Access;
  clock?: KernelClock;
};

export type ResolvedSubject = { subjectId: string; requestedSubjectId: null };

function accessDeadline(clock: KernelClock): number {
  const now = clock().getTime();
  if (!Number.isFinite(now)) throw new RangeError('Kernel clock must return a valid date');
  return now + ACCESS_BUDGET_MS;
}

/** Resolve a subject on its own anchor using the semantic subject:read policy. */
export async function resolveSubject(
  deps: SubjectAnchorDependencies,
  actor: Actor,
  subjectId: string,
): Promise<ResolvedSubject | null> {
  const route = routeOf(subjectId);
  if (route === null) return null;

  const resource = { route, id: subjectId, eligibility: subjectReadEligibility({ route, id: subjectId }) };
  const check = await accessCheck(deps.access, actor, 'subject:read', resource, {
    pool: deps.pool,
    deadline: accessDeadline(deps.clock ?? systemClock),
  });
  const result = await readSubject(deps.pool, subjectId, (client) => check(client));
  return result ? { subjectId, requestedSubjectId: null } : null;
}

/** Filter a bounded page's IDs through one semantic anchored read per distinct subject. */
export async function readableSubjects(
  deps: SubjectAnchorDependencies,
  actor: Actor,
  subjectIds: readonly string[],
): Promise<string[]> {
  if (subjectIds.length > MAX_SUBJECT_IDS)
    throw new RangeError(`Subject page must contain at most ${MAX_SUBJECT_IDS} IDs`);

  const distinctIds = [...new Set(subjectIds)];
  const resolved: (ResolvedSubject | null)[] = new Array(distinctIds.length);
  let nextIndex = 0;
  const outcomes = await Promise.allSettled(
    Array.from({ length: Math.min(MAX_CONCURRENT_SUBJECT_READS, distinctIds.length) }, async () => {
      while (nextIndex < distinctIds.length) {
        const index = nextIndex++;
        resolved[index] = await resolveSubject(deps, actor, distinctIds[index]!);
      }
    }),
  );
  const failure = outcomes.find((outcome) => outcome.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
  return resolved.flatMap((subject) => (subject ? [subject.subjectId] : []));
}
