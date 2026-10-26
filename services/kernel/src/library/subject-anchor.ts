import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import { accessCheck, type Access, type Actor } from '../request/access.ts';
import { deadlineFor } from '../request/deadline.ts';
import { routeOf } from '../route/route.ts';
import { subjectReadEligibility } from '../semantic/eligibility.ts';
import { SubjectRedirectError } from '../semantic/merges.ts';
import { readSubject } from '../semantic/subject.ts';
import { WORK_STEP_DEADLINE_MS } from './command-support.ts';

const MAX_SUBJECT_IDS = 100;
const MAX_CONCURRENT_SUBJECT_READS = 4;

export type SubjectAnchorDependencies = {
  pool: Pool;
  access: Access;
  clock?: KernelClock;
};

export type ResolvedSubject = { subjectId: string; requestedSubjectId: string | null };

/** Resolve a subject on its own anchor using the semantic subject:read policy. */
export async function resolveSubject(
  deps: SubjectAnchorDependencies,
  actor: Actor,
  subjectId: string,
): Promise<ResolvedSubject | null> {
  async function readAnchor(id: string) {
    const route = routeOf(id);
    if (route === null) return null;
    const resource = { route, id, eligibility: subjectReadEligibility({ route, id }) };
    const check = await accessCheck(deps.access, actor, 'subject:read', resource, {
      pool: deps.pool,
      deadline: deadlineFor(WORK_STEP_DEADLINE_MS),
    });
    return readSubject(deps.pool, id, (client) => check(client));
  }

  try {
    const result = await readAnchor(subjectId);
    return result ? { subjectId, requestedSubjectId: null } : null;
  } catch (error) {
    if (!(error instanceof SubjectRedirectError)) throw error;
    if (error.from !== subjectId) return null;
    try {
      const survivor = await readAnchor(error.to);
      return survivor ? { subjectId: error.to, requestedSubjectId: subjectId } : null;
    } catch (survivorError) {
      if (survivorError instanceof SubjectRedirectError) return null;
      throw survivorError;
    }
  }
}

/** Keep stored IDs that resolve in one hop, preserving page identity and bounds. */
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
  return distinctIds.flatMap((id, index) => (resolved[index] ? [id] : []));
}
