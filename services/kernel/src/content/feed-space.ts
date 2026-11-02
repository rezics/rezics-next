import { isDeepStrictEqual } from 'node:util';
import { accessCheck, type Actor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { readSpaceForViewer, spaceReadEligibility } from '../community/space.ts';
import { readPublication } from '../community/publication.ts';
import { readBoards, type ThreadView } from './reads.ts';
import type { ActivityRef } from './feed-activity.ts';
import type { FeedDependencies } from './feed.ts';
import { ProblemError } from '../http/problem.ts';

/** Membership of the already bounded native Following population, never public
 * Discovery/Continue coverage. Preserve one result for every examined activity.
 */
export async function readFollowingSpaceMembership(
  deps: FeedDependencies,
  actor: Actor,
  spaceId: string,
  activities: readonly ActivityRef[],
  threads: ReadonlyMap<string, ThreadView | null>,
  deadline: number,
): Promise<readonly boolean[]> {
  if (activities.length > 20) throw new RangeError('At most 20 Following candidates');
  const route = routeOf(spaceId);
  if (route === null) throw new ProblemError('invalid_request');
  const context = { actor, deadline };
  const check = await accessCheck(
    deps.access,
    actor,
    'space:read',
    { route, id: spaceId, eligibility: spaceReadEligibility({ route, id: spaceId }) },
    { pool: deps.pool, deadline },
  );
  const readSpace = () =>
    readSpaceForViewer(deps, actor, spaceId, deps.clock().toISOString(), context, check);
  const initial = await readSpace();
  if (!initial) return activities.map(() => false);
  const boardIds = [...new Set(activities.flatMap(({ object }) => {
    if (object.owner !== 'content') return [];
    const thread = threads.get(object.threadId);
    return thread ? [thread.boardId] : [];
  }))];
  // Complete anchored native board reads retain current parent and Space disclosure.
  const boards = await readBoards({ ...deps, access: deps.contentAccess }, boardIds, context);
  const byBoard = new Map(boardIds.map((id, index) => [id, boards[index]!.value]));
  const result = await Promise.all(activities.map(async ({ object }) => {
    if (object.owner === 'content') {
      const thread = threads.get(object.threadId);
      return !!thread && byBoard.get(thread.boardId)?.community?.spaceId === spaceId;
    }
    if (object.owner !== 'semantic' || object.realmId !== initial.realmId) return false;
    // An attached Subject or old follow reason cannot replace the current adoption.
    const publication = await readPublication(deps, object.realmId, object.id, context);
    return publication?.publicationId === object.publicationId;
  }));
  // A replacement Realm or changed Space invalidates this batch's positives.
  const final = await readSpace();
  return isDeepStrictEqual(initial, final) ? result : activities.map(() => false);
}
