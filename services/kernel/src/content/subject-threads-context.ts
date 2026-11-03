import { requireAccessDeadline } from '../access/unavailable.ts';
import { readRealm, type RealmView } from '../community/realm.ts';
import { ProblemError } from '../http/problem.ts';
import { accessCheck } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { GLOBAL_CONTEXT } from '../semantic/definitions.ts';
import { subjectReadEligibility } from '../semantic/eligibility.ts';
import { SubjectRedirectError } from '../semantic/merges.ts';
import { withReadTransaction } from '../semantic/read.ts';
import { readSubjectReference } from '../semantic/references.ts';
import { prepareEditionSubjectIdentities } from './edition-subject.ts';
import type { ReadContext } from './model.ts';
import { ContentNotFoundError, type ContentReadDependencies } from './reads.ts';

export type SubjectThreadContext = Readonly<{
  subject: Readonly<{
    id: string;
    label: Readonly<{ value: string; language: string }> | null;
    source: Readonly<{ partition: number; epoch: number; position: string }>;
  }>;
  place:
    | Readonly<{ kind: 'global'; id: string }>
    | Readonly<{ kind: 'realm'; id: string; title: string; spaceId: string; headRevisionId: string }>;
  kind: 'discussion' | 'review';
}>;

/** Current list identity only. It conveys no creation or command authority. */
export async function prepareSubjectThreadContext(
  deps: ContentReadDependencies,
  subjectId: string,
  placeId: string,
  kind: SubjectThreadContext['kind'],
  context: ReadContext,
): Promise<Readonly<{ finish(): Promise<SubjectThreadContext> }>> {
  const route = routeOf(subjectId);
  if (route === null || routeOf(placeId) === null) throw new ContentNotFoundError();
  requireAccessDeadline(context.deadline);
  // Reuse the installed current label disclosure. No images, inferred labels,
  // redirected identities or new Semantic display resolver enter this list.
  const identities = await prepareEditionSubjectIdentities(deps, [subjectId], context);
  async function subject(): Promise<SubjectThreadContext['subject']> {
    const check = await accessCheck(
      deps.access,
      context.actor,
      'subject:read',
      { route: route!, id: subjectId, eligibility: subjectReadEligibility({ route: route!, id: subjectId }) },
      { pool: deps.pool, deadline: context.deadline },
    );
    try {
      return await withReadTransaction(
        deps.pool,
        async () => {
          const reference = await readSubjectReference(deps.pool, subjectId, check);
          if (!reference) throw new ContentNotFoundError();
          // Both native readers inherit the same released Subject-home snapshot.
          const identity = (await identities()).get(subjectId);
          if (!identity || identity.kind === 'withheld') throw new ContentNotFoundError();
          return {
            id: reference.id,
            label: identity.label,
            source: {
              partition: reference.component.partition,
              epoch: reference.component.epoch,
              position: reference.component.position.toString(),
            },
          };
        },
        context.deadline,
      );
    } catch (error) {
      // The original selection is never silently rewritten to a merge target.
      if (error instanceof SubjectRedirectError) throw new ContentNotFoundError();
      throw error;
    }
  }
  async function place(): Promise<RealmView | null> {
    requireAccessDeadline(context.deadline);
    if (placeId === GLOBAL_CONTEXT) return null;
    const realm = await readRealm(deps, context.actor, placeId, { deadline: context.deadline });
    if (!realm) throw new ContentNotFoundError();
    return realm;
  }
  const originalSubject = await subject();
  // No Subject connection survives this foreign-home call.
  const originalPlace = await place();
  return {
    async finish() {
      const currentPlace = await place();
      const currentSubject = await subject();
      // Compare the actual observations, including the native Subject component
      // and Realm head, rather than equating sources because their IDs match.
      if (
        JSON.stringify(currentSubject) !== JSON.stringify(originalSubject) ||
        JSON.stringify(currentPlace) !== JSON.stringify(originalPlace)
      )
        throw new ProblemError('dependency_unavailable');
      requireAccessDeadline(context.deadline);
      return {
        subject: currentSubject,
        place: currentPlace
          ? {
              kind: 'realm',
              id: currentPlace.realmId,
              title: currentPlace.title,
              spaceId: currentPlace.spaceId,
              headRevisionId: currentPlace.headRevisionId,
            }
          : { kind: 'global', id: GLOBAL_CONTEXT },
        kind,
      };
    },
  };
}
