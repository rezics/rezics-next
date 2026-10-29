import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import type { AuthoritativeTime } from '../command/command.ts';
import { accessCheck, type Access, type Actor } from '../request/access.ts';
import { deadlineFor } from '../request/deadline.ts';
import { routeOf } from '../route/route.ts';
import { subjectReadEligibility } from '../semantic/eligibility.ts';
import { SubjectRedirectError } from '../semantic/merges.ts';
import { readSubjectReference } from '../semantic/references.ts';
import { identityEpochStore } from '../semantic/identity-epoch-store.ts';
import { WORK_STEP_DEADLINE_MS } from './command-support.ts';

const MAX_SUBJECT_IDS = 100;
const MAX_CONCURRENT_SUBJECT_READS = 4;

export type SubjectAnchorDependencies = {
  pool: Pool;
  access: Access;
  clock?: KernelClock;
};

export type ResolvedSubject = { subjectId: string; requestedSubjectId: string | null };

export class SubjectIdentityUnavailableError extends Error {
  constructor(public readonly reason: 'bootstrap' | 'missing-owner' | 'moved-owner') {
    super(`Current subject identity is unavailable: ${reason}`);
  }
}

/** Resolve a subject on its own anchor using the semantic subject:read policy. */
export async function resolveSubject(
  deps: SubjectAnchorDependencies,
  actor: Actor,
  subjectId: string,
  at?: AuthoritativeTime,
): Promise<ResolvedSubject | null> {
  async function authorizeAnchor(id: string) {
    const route = routeOf(id);
    if (route === null) return null;
    const resource = { route, id, eligibility: subjectReadEligibility({ route, id }) };
    const check = await accessCheck(deps.access, actor, 'subject:read', resource, {
      pool: deps.pool,
      deadline: deadlineFor(WORK_STEP_DEADLINE_MS),
    });
    return (client: Parameters<typeof check>[0]) => check(client, at);
  }
  const mapping = await identityEpochStore.readMapping(deps.pool, subjectId);
  if (mapping.state === 'absent') return null;
  if (mapping.state === 'pending') return null;
  if (mapping.state === 'unavailable') throw new SubjectIdentityUnavailableError(mapping.reason);

  const originalAuthorization = await authorizeAnchor(subjectId);
  if (!originalAuthorization) return null;
  const terminalAuthorization = await authorizeAnchor(mapping.terminal);
  if (!terminalAuthorization) return null;

  try {
    const original = await readSubjectReference(deps.pool, subjectId, originalAuthorization);
    if (!original || mapping.terminal !== subjectId) return null;
  } catch (error) {
    if (!(error instanceof SubjectRedirectError)) throw error;
    if (error.from !== subjectId || error.to !== mapping.terminal) return null;
  }
  const terminal = await readSubjectReference(deps.pool, mapping.terminal, terminalAuthorization);
  return terminal
    ? {
        subjectId: mapping.terminal,
        requestedSubjectId: mapping.terminal === subjectId ? null : subjectId,
      }
    : null;
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
