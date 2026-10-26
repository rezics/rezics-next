import type { AccessClient } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import post from './realm-of-post.sql';
import thread from './realm-of-thread.sql';
import board from './realm-of-board.sql';

/** Follow relationships with a point read on each resource's own route. */
export async function realmOfItem(
  client: AccessClient,
  kind: 'thread' | 'post',
  route: number,
  id: string,
): Promise<string | null> {
  if (kind === 'post') {
    const parameters = { route, id };
    const { rows } = await client.query<(typeof post)['~reylo']['element']>(
      post.sql,
      post.params.map((name) => parameters[name as keyof typeof parameters]),
    );
    const found = rows[0];
    if (!found) return null;
    id = found.thread_id;
    const threadRoute = routeOf(id);
    if (threadRoute === null) return null;
    route = threadRoute;
  }

  const parameters = { route, id };
  const { rows } = await client.query<(typeof thread)['~reylo']['element']>(
    thread.sql,
    thread.params.map((name) => parameters[name as keyof typeof parameters]),
  );
  const found = rows[0];
  if (!found) return null;
  const boardRoute = routeOf(found.board_id);
  if (boardRoute === null) return null;
  const boardParameters = { route: boardRoute, id: found.board_id };
  const result = await client.query<(typeof board)['~reylo']['element']>(
    board.sql,
    board.params.map((name) => boardParameters[name as keyof typeof boardParameters]),
  );
  return result.rows[0]?.realm_id ?? null;
}
