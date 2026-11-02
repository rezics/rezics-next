import type { AccessClient } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import type { ReportTarget } from './reports.ts';
import postThread from './read-report-post-thread.sql';
import thread from './read-report-thread.sql';

/** Native point reads only, on the target route. Queue membership never grants authority. */
export async function reportBoardPlacement(client: AccessClient, target: ReportTarget): Promise<string | null> {
  if (target.kind === 'subject') return null;
  if (target.kind === 'board') return target.id;
  const route = routeOf(target.id);
  if (route === null) return null;
  const located = target.kind === 'post' ? await postThread.run(client, { route, id: target.id }) : null;
  const threadId = target.kind === 'post' ? located?.thread_id : target.id;
  if (!threadId || routeOf(threadId) !== route) return null;
  const row = await thread.run(client, { route, id: threadId });
  return row && routeOf(row.board_id) !== null ? row.board_id : null;
}
