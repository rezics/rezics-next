import type { Pool } from 'pg';
import type { AuthoritativeTime } from '../command/command.ts';
import type { Access, AccessContext, AccessCheck } from '../request/access.ts';
import type { AuthorizationAnchor } from '../access/resource-authorization.ts';
import { routeOf } from '../route/route.ts';
import { subjectReadEligibility } from '../semantic/eligibility.ts';
import readSubjectReference from '../semantic/read-subject-reference.sql';
import { editionSnapshot } from './edition-store.ts';

export type EditionSourceAuthorization = (action: string, anchor: AuthorizationAnchor) => Promise<AccessCheck>;

/** The pinned ID stays Semantic-owned. A redirect never rewrites a sold binding.
 * Each observation releases the subject home before any edition checkout. */
export async function prepareEditionSubject(
  deps: Readonly<{ pool: Pool; access: Access }>,
  targetSubjectId: string,
  time: AuthoritativeTime,
  accessContext: AccessContext,
  authorize: EditionSourceAuthorization,
): Promise<Readonly<{ final(): Promise<boolean> }> | null> {
  const route = routeOf(targetSubjectId);
  if (route === null) return null;
  const resource = { route, id: targetSubjectId, eligibility: subjectReadEligibility({ route, id: targetSubjectId }) };
  const validate = async (client: Parameters<Access['authorize']>[0]) => {
    const subject = await readSubjectReference.run(client, { route, subject_id: targetSubjectId });
    return !!subject && subject.id === targetSubjectId && subject.redirect === null;
  };
  if (!(await editionSnapshot(deps, targetSubjectId, accessContext, validate)).value) return null;
  const allowed = await authorize('subject:read', { resource, validate });
  const final = async () =>
    (
      await editionSnapshot(deps, targetSubjectId, accessContext, async (client) => {
        return (await validate(client)) && (await allowed(client, time));
      })
    ).value;
  return (await final()) ? { final } : null;
}
