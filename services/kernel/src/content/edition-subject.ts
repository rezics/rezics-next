import { accessCheck } from './access-port.ts';
import { partitionReadClients } from '../database/read-snapshot.ts';
import { withReadTransaction } from '../semantic/read.ts';
import { chooseLabel } from '../semantic/language.ts';
import readLabels from '../semantic/read-related.sql';
import type { EditionSubjectIdentity } from './edition-model.ts';
import type { ReadContext } from './model.ts';
import { ContentNotFoundError } from './reads.ts';
import type { Pool } from 'pg';
import type { AuthoritativeTime } from '../command/command.ts';
import type { Access, AccessContext, AccessCheck } from '../request/access.ts';
import type { AuthorizationAnchor } from '../access/resource-authorization.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { subjectReadEligibility } from '../semantic/eligibility.ts';
import readSubjectReference from '../semantic/read-subject-reference.sql';
import { editionSnapshot } from './edition-store.ts';

export type EditionSourceAuthorization = (action: string, anchor: AuthorizationAnchor) => Promise<AccessCheck>;

/** The pinned ID stays Semantic-owned. A redirect never rewrites a sold binding.
 * Each observation releases the subject home before any edition checkout. */
export async function prepareEditionSubject(
  deps: Readonly<{ pool: Pool; access: Access; clock: () => Date }>,
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

/** Two bounded label observations share ordinary subject Access preparation.
 * Call the returned reader after native source fences to refresh grants and labels
 * in one snapshot. Redirects never substitute another publication target. */
export async function prepareEditionSubjectIdentities(
  deps: Readonly<{ pool: Pool; access: Access }>,
  ids: readonly string[],
  context: ReadContext,
) {
  if (ids.length > 128) throw new RangeError('Edition identity accepts at most 128 subjects');
  const keys = [...new Set(ids)];
  const checks = new Map<string, AccessCheck>();
  for (const id of keys) {
    const route = routeOf(id);
    if (route === null) throw new ContentNotFoundError();
    checks.set(
      id,
      await accessCheck(
        deps.access,
        context.actor,
        'subject:read',
        {
          route,
          id,
          eligibility: subjectReadEligibility({ route, id }),
        },
        { pool: deps.pool, deadline: context.deadline },
      ),
    );
  }
  const read = () =>
    withReadTransaction(
      deps.pool,
      async (client) => {
        const partitions = [...new Set(keys.map((id) => partitionOf(routeOf(id)!)))];
        await partitionReadClients(client, partitions);
        const result = new Map<string, EditionSubjectIdentity>();
        for (const partition of partitions) {
          const group = keys.filter((id) => partitionOf(routeOf(id)!) === partition);
          const labels = await readLabels.run(client, {
            partition_no: partition,
            routes: group.map((id) => routeOf(id)!),
            subject_ids: group,
          });
          const found = new Map(labels.map((row) => [row.id, row]));
          for (const id of group) {
            if (
              !(await checks.get(id)!(client)) ||
              found.get(id)?.redirect ||
              found.get(id)?.visibility !== 'visible'
            ) {
              result.set(id, { id, kind: 'withheld', label: null });
              continue;
            }
            const row = found.get(id);
            const label = row ? chooseLabel(row.labels as Record<string, string>, []) : null;
            // The original target stays pinned, including when a redirect exists.
            result.set(id, { id, kind: label ? 'available' : 'missing', label });
          }
        }
        return result;
      },
      context.deadline,
    );
  // Prepare Access before native source fences, then refresh labels and grants
  // after composition without preparing another authority in between.
  await read();
  return read;
}
