import type { Pool } from 'pg';
import type { SubjectIdentityCapability, SubjectReferenceObservation } from '../../library/contract/index.ts';
import type { AuthoritativeTime } from '../../command/command.ts';
import { accessCheck, type Access, type AccessContext, type Actor } from '../../request/access.ts';
import { routeOf } from '../../route/route.ts';
import type { IdentityMapping } from '../contract/index.ts';
import { SubjectRedirectError } from '../contract/subject-errors.ts';
import { subjectReadEligibility } from '../eligibility.ts';
import type { SummaryReaderDependencies } from '../summaries.ts';
import type {
  LibrarySemanticObservationCapability,
  LibrarySemanticObservationResult,
  LibrarySemanticSummaryContext,
} from '../../library/contract/semantic-observation.ts';
import type { WorkDimensions } from '../../library/contract/work-dimensions.ts';

export type LibrarySubjectIdentityContext = Readonly<{
  pool: Pool;
  access: Access;
  actor: Actor;
  at?: AuthoritativeTime;
  context: AccessContext;
}>;

/** Uses the single Identity producer. Mapping never supplies authorization or native disclosure. */
export type LibrarySubjectReferenceResult = SubjectReferenceObservation & Readonly<{ work: WorkDimensions }>;
export type LibrarySubjectIdentityAdapter = Omit<
  SubjectIdentityCapability<LibrarySubjectIdentityContext, IdentityMapping>,
  'prepareReference'
> & {
  prepareReference(
    context: LibrarySubjectIdentityContext,
    id: string,
  ): Promise<() => Promise<LibrarySubjectReferenceResult>>;
};

export function createLibrarySubjectIdentityAdapter(
  observations: LibrarySemanticObservationCapability,
): LibrarySubjectIdentityAdapter {
  return {
    redirected: (from, to) => new SubjectRedirectError(from, to),
    validId: (id) => routeOf(id) !== null,
    async readMappings(context, ids) {
      return (await observations.follow.readMappings(context.pool, ids)).value as readonly IdentityMapping[];
    },
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
        const result = await observations.follow.readSubjectReference({
          pool: context.pool,
          subjectId: id,
          check: (client) => check(client as Parameters<typeof check>[0], context.at),
        });
        return Object.freeze({ ...result.value, work: result.work }) as LibrarySubjectReferenceResult;
      };
    },
  };
}

/** One native bounded summary observation; all its Source, cover and disclosure fences survive composition. */
export async function observeLibrarySubjectSummaries(
  observations: LibrarySemanticObservationCapability,
  deps: SummaryReaderDependencies,
  ids: readonly string[],
) {
  return observations.follow.observeSubjects({
    context: deps as LibrarySemanticSummaryContext,
    ids,
  });
}

/** Original inputs retain the exact producer mapping including epoch, pending job and unavailable reason. */
export async function readLibraryIdentityMappings(
  observations: LibrarySemanticObservationCapability,
  pool: Pool,
  ids: readonly string[],
) {
  const result = await observations.follow.readMappings(pool, ids);
  return { ...result, value: result.value as readonly IdentityMapping[] };
}
