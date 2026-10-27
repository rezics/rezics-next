import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import type { AuthoritativeTime } from '../command/command.ts';
import { accessCheck, type Access, type Actor } from '../request/access.ts';
import { deadlineFor } from '../request/deadline.ts';
import { routeOf } from '../route/route.ts';
import { subjectReadEligibility } from '../semantic/eligibility.ts';
import { SubjectRedirectError } from '../semantic/merges.ts';
import { withReadTransaction } from '../semantic/read.ts';
import readSubject from '../semantic/read-subject.sql';
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
  at?: AuthoritativeTime,
): Promise<ResolvedSubject | null> {
  async function readAnchor(id: string) {
    const route = routeOf(id);
    if (route === null) return null;
    const resource = { route, id, eligibility: subjectReadEligibility({ route, id }) };
    const check = await accessCheck(deps.access, actor, 'subject:read', resource, {
      pool: deps.pool,
      deadline: deadlineFor(WORK_STEP_DEADLINE_MS),
    });
    // Anchoring needs current identity, not a rendered subject's link projection.
    return withReadTransaction(deps.pool, async (client) => {
      const rows = await readSubject.run(client, { route, subject_id: id });
      const subject = (Array.isArray(rows) ? rows[0] : rows) as { redirect: string | null } | null;
      if (!subject || !(await check(client, at))) return null;
      if (subject.redirect) throw new SubjectRedirectError(id, subject.redirect);
      return subject;
    });
  }

  const visited = new Set<string>();
  let current = subjectId;
  while (!visited.has(current)) {
    visited.add(current);
    try {
      const result = await readAnchor(current);
      return result ? { subjectId: current, requestedSubjectId: current === subjectId ? null : subjectId } : null;
    } catch (error) {
      if (!(error instanceof SubjectRedirectError)) throw error;
      if (error.from !== current) return null;
      current = error.to;
    }
  }
  return null;
}

/** Keep stored IDs that resolve, preserving page identity and bounds. */
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
