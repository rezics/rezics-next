import type { Actor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import type { HostedDependencies } from './hosted-chapters-model.ts';
import { snapshot } from './reads.ts';
import associationSql from './hosted-reading-association.sql';

type AssociationRow = Readonly<{ associated: boolean }>;

/** Checks the same two native association sources as Subject catalogue discovery. */
export async function hasHostedReadingSubjectAssociation(
  dependencies: HostedDependencies,
  actor: Actor,
  subjectId: string,
  catalogueId: string,
  deadline: number,
): Promise<boolean> {
  const subjectRoute = routeOf(subjectId);
  const catalogueRoute = routeOf(catalogueId);
  if (subjectRoute === null || catalogueRoute === null) return false;

  const context = { actor, deadline };
  const selected = await snapshot(dependencies, subjectId, context, async (client) => {
    const result = await associationSql.run(client, {
      subject_route: subjectRoute,
      subject_id: subjectId,
      catalogue_route: catalogueRoute,
      catalogue_id: catalogueId,
    });
    const row = Array.isArray(result) ? result[0] : result;
    return (row as AssociationRow | undefined)?.associated === true;
  });
  return selected.value;
}
