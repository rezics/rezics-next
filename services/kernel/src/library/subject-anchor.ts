import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import type { AuthoritativeTime } from '../command/command.ts';
import type { Access, AccessContext, Actor } from '../request/access.ts';
import { deadlineFor } from '../request/deadline.ts';
import { WORK_STEP_DEADLINE_MS } from './work-step-deadline.ts';
import { requireLibraryPresentation } from './domain-binding.ts';
export { SubjectIdentityUnavailableError, type ResolvedSubject } from './contract/index.ts';

export type SubjectAnchorDependencies = { pool: Pool; access: Access; clock?: KernelClock };

/** Compatibility entry: the application owns redirect/identity orchestration, Semantic owns native observations. */
export function resolveSubject(
  deps: SubjectAnchorDependencies,
  actor: Actor,
  subjectId: string,
  at?: AuthoritativeTime,
  context?: AccessContext,
) {
  return requireLibraryPresentation().identity.resolve(
    {
      ...deps,
      actor,
      ...(at === undefined ? {} : { at }),
      context: context ?? { pool: deps.pool, deadline: deadlineFor(WORK_STEP_DEADLINE_MS) },
    },
    subjectId,
  );
}

/** Preserve stored keys, input ordering, the 100-ID limit and four concurrent reads. */
export function readableSubjects(
  deps: SubjectAnchorDependencies,
  actor: Actor,
  subjectIds: readonly string[],
  at?: AuthoritativeTime,
) {
  return requireLibraryPresentation().identity.readable(
    {
      ...deps,
      actor,
      ...(at === undefined ? {} : { at }),
      context: { pool: deps.pool, deadline: deadlineFor(WORK_STEP_DEADLINE_MS) },
    },
    subjectIds,
  );
}
