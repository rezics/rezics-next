import type { Pool } from 'pg';
import { accessCheck, type Access, type Actor } from '../request/access.ts';
import { readSpaceForViewer, spaceReadEligibility } from '../community/space.ts';
import { ProblemError } from '../http/problem.ts';
import { feedRoute } from './feed-activity.ts';
import { readBoard } from './reads.ts';
import type { KeyRing } from '../tokens/seal.ts';

/** Following already owns a finite native candidate inbox. Space membership is
 * checked on each candidate's current native container, never its follow reason.
 * This reader supplies no discovery or Continue population coverage.
 */
export async function openFollowingSpace(
  deps: { pool: Pool; access: Access; contentAccess: Access; tokens: KeyRing; clock?: () => Date },
  actor: Actor,
  spaceId: string,
  deadline: number,
  at: string,
) {
  const resource = { route: feedRoute(spaceId), id: spaceId };
  const check = await accessCheck(
    deps.access,
    actor,
    'space:read',
    { ...resource, eligibility: spaceReadEligibility(resource) },
    { pool: deps.pool, deadline },
  );
  const read = () => readSpaceForViewer(deps, actor, spaceId, at, { deadline }, check);
  const initial = await read();
  if (!initial || initial.state !== 'active') throw new ProblemError('not_found');
  const boards = new Map<string, Promise<boolean>>();
  return {
    spaceId,
    headRevisionId: initial.headRevisionId,
    realmId: initial.realmId,
    containsBoard(boardId: string): Promise<boolean> {
      let result = boards.get(boardId);
      if (!result) {
        result = readBoard({ ...deps, access: deps.contentAccess }, boardId, { actor, deadline }).then(
          ({ value }) => value?.community?.spaceId === spaceId,
        );
        boards.set(boardId, result);
      }
      return result;
    },
    async finish(): Promise<void> {
      const final = await read();
      if (
        !final ||
        final.state !== 'active' ||
        final.headRevisionId !== initial.headRevisionId ||
        final.realmId !== initial.realmId
      )
        throw new ProblemError('stale_cursor');
    },
  };
}

export type FollowingSpace = Awaited<ReturnType<typeof openFollowingSpace>>;
