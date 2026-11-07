import type { Pool } from 'pg';
import { classifyUnavailability } from '../access/unavailable.ts';
import type { CommunityPresentation } from '../content/community-presentation-model.ts';
import { readCommunityPresentations } from './domain-ports.ts';
import type { ReadContext } from '../content/model.ts';
import { ProblemError } from '../http/problem-error.ts';
import type { Access } from '../request/access.ts';
import { routeOf } from '../route/route.ts';

/** The native reader owns both Realm/Space rounds and all optional source checks.
 * A home consumes that protocol once, without a second presentation authority.
 */
export async function readRealmHomePresentation(
  deps: Readonly<{ pool: Pool; access: Access; clock: () => Date; deadlineNow: () => number }>,
  realmId: string,
  context: ReadContext,
): Promise<CommunityPresentation | null> {
  if (routeOf(realmId) === null) return null;
  try {
    return (await readCommunityPresentations(deps, [realmId], context)).get(realmId) ?? null;
  } catch (error) {
    if (error instanceof ProblemError) {
      if (error.code === 'not_found') return null;
      throw error;
    }
    const reason = classifyUnavailability(error);
    throw new ProblemError(
      reason === 'deadline'
        ? 'deadline_exceeded'
        : reason === 'contention'
          ? 'transaction_retry_exhausted'
          : reason === 'overloaded'
            ? 'overloaded'
            : reason === 'moved' || reason === 'fenced'
              ? 'partition_unavailable'
              : 'dependency_unavailable',
    );
  }
}
