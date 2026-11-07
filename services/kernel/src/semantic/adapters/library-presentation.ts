import type { Pool } from 'pg';
import type { SubjectIdentityCapability } from '../../library/contract/index.ts';
import type { AuthoritativeTime } from '../../command/command.ts';
import { accessCheck, type Access, type AccessContext, type Actor } from '../../request/access.ts';
import { routeOf } from '../../route/route.ts';
import type { IdentityMapping } from '../contract/index.ts';
import { identityEpochStore } from '../identity-adapters/index.ts';
import { subjectReadEligibility } from '../eligibility.ts';
import { readSubjectReference } from '../references.ts';
import { SubjectRedirectError } from '../merges.ts';
import { readSubjectSummaryObservation, type SummaryReaderDependencies } from '../summaries.ts';

export type LibrarySubjectIdentityContext = Readonly<{
  pool: Pool;
  access: Access;
  actor: Actor;
  at?: AuthoritativeTime;
  context: AccessContext;
}>;

/** Uses the single Identity producer. Mapping never supplies authorization or native disclosure. */
export function createLibrarySubjectIdentityAdapter(): SubjectIdentityCapability<
  LibrarySubjectIdentityContext,
  IdentityMapping
> {
  return {
    redirected: (from, to) => new SubjectRedirectError(from, to),
    validId: (id) => routeOf(id) !== null,
    readMappings: (context, ids) => identityEpochStore().readMappings(context.pool, ids),
    async prepareReference(context, id) {
      const route = routeOf(id)!;
      const check = await accessCheck(
        context.access,
        context.actor,
        'subject:read',
        {
          route,
          id,
          eligibility: subjectReadEligibility({ route, id }),
        },
        context.context,
      );
      return async () => {
        try {
          const value = await readSubjectReference(context.pool, id, (client) => check(client, context.at));
          return { state: value ? ('present' as const) : ('absent' as const) };
        } catch (error) {
          if (!(error instanceof SubjectRedirectError)) throw error;
          return { state: 'redirect', from: error.from, to: error.to };
        }
      };
    },
  };
}

/** One native bounded summary observation; all its Source, cover and disclosure fences survive composition. */
export function observeLibrarySubjectSummaries(deps: SummaryReaderDependencies, ids: readonly string[]) {
  return readSubjectSummaryObservation(deps, ids, { displayFallback: true });
}

/** Original inputs retain the exact producer mapping including epoch, pending job and unavailable reason. */
export function readLibraryIdentityMappings(pool: Pool, ids: readonly string[]) {
  return identityEpochStore().readMappings(pool, ids);
}
