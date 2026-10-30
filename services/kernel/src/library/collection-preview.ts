import { deadlineClient } from '../access/authenticate.ts';
import { ProblemError } from '../http/problem.ts';
import type { Actor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { readCurrentSubjectSummaries } from '../semantic/current-subject-summaries.ts';
import { withReadTransaction } from '../semantic/read.ts';
import type { SubjectSummary } from '../semantic/summaries.ts';
import type { PresentationDependencies } from './collection-presentation.ts';
import membersRead from './collection-preview-members.sql';
import fencesRead from './collection-preview-fences.sql';

export type CollectionPreview = {
  previewMembers: { subjectId: string; subject: SubjectSummary }[];
  previewStatus: 'ready' | 'pending';
};
export type PreviewParent = {
  id: string;
  revision: number;
  sourceGeneration: string;
  membershipKind: string;
};

/** One native home batch and one native display batch. No retained writes are performed.
 * An unfinished prefix is pending with no partial successful projection.
 */
export async function readCollectionPreviews(
  deps: PresentationDependencies,
  actor: Actor,
  parents: readonly PreviewParent[],
  deadline: number,
  authorizeCurrent: (parent: PreviewParent) => Promise<void>,
  prepareUnresolved?: (previews: ReadonlyMap<string, CollectionPreview>) => Promise<void>,
): Promise<Map<string, CollectionPreview>> {
  if (parents.length > 20) throw new ProblemError('invalid_request');
  const result = new Map<string, CollectionPreview>(
    parents.map(({ id }) => [
      id,
      {
        previewMembers: [],
        previewStatus: 'pending',
      },
    ]),
  );
  if (!parents.length) return result;
  const route = routeOf(parents[0]!.id);
  if (route === null || parents.some((parent) => routeOf(parent.id) !== route))
    throw new ProblemError('dependency_unavailable');
  for (const parent of parents) await authorizeCurrent(parent);
  const selected = parents.filter((parent) => parent.membershipKind === 'curated');
  if (!selected.length) return result;
  const quota = Math.floor(100 / selected.length);
  const binding = {
    routes: selected.map(() => route),
    collection_ids: selected.map((parent) => parent.id),
    source_generations: selected.map((parent) => parent.sourceGeneration),
    revisions: selected.map((parent) => parent.revision),
  };
  const rows = await withReadTransaction(deps.pool, (client) =>
    membersRead.run(deadlineClient(client, deadline), {
      ...binding,
      per_parent: quota,
    }),
  );
  const originals = [
    ...new Set(rows.flatMap((row) => (row.subjectId && row.deletionId === null ? [row.subjectId] : []))),
  ];
  if (originals.length && !deps.routeKey) throw new ProblemError('dependency_unavailable');
  const display = originals.length
    ? await readCurrentSubjectSummaries({ ...deps, actor, routeKey: deps.routeKey!, deadline }, originals)
    : { summaries: new Map<string, SubjectSummary | null>(), verify: async () => {} };
  for (const parent of selected) {
    const prefix = rows.filter((row) => row.collectionId === parent.id);
    if (!prefix.length) throw new ProblemError('dependency_unavailable');
    const raw = prefix.filter((row) => row.subjectId !== null);
    const members: CollectionPreview['previewMembers'] = [];
    const seen = new Set<string>();
    for (const row of raw) {
      if (row.deletionId !== null) continue;
      const subject = display.summaries.get(row.subjectId!);
      if (!subject || seen.has(subject.id)) continue;
      seen.add(subject.id);
      members.push({ subjectId: subject.id, subject });
      if (members.length === 3) break;
    }
    const exhausted = raw.length < quota;
    if (members.length === 3 || exhausted) result.set(parent.id, { previewMembers: members, previewStatus: 'ready' });
  }
  await prepareUnresolved?.(result);
  await display.verify();
  const current = await withReadTransaction(deps.pool, (client) =>
    fencesRead.run(deadlineClient(client, deadline), binding),
  );
  const generations = new Map(current.map((row) => [row.collectionId, row.nativeGeneration]));
  if (
    selected.some((parent) => {
      const before = rows.find((row) => row.collectionId === parent.id);
      return !before || generations.get(parent.id) !== before.nativeGeneration;
    })
  )
    throw new ProblemError('dependency_unavailable');
  for (const parent of parents) await authorizeCurrent(parent);
  return result;
}
