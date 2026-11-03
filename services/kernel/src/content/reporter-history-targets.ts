import type { Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { readCurrentSubjectSummaries } from '../semantic/current-subject-summaries.ts';
import { discloseThreads, readBoards, readPost, snapshot } from './reads.ts';
import type { ReportDependencies, ReportTarget } from './reports.ts';
import postLocations from './reporter-history-posts.sql';

export type ReporterTargetSummary =
  | Readonly<{ state: 'available'; label: string | null; href: string }>
  | Readonly<{ state: 'unavailable' }>;
type Context = Readonly<{ actor: Actor; deadline: number }>;
const unavailable = Object.freeze({ state: 'unavailable' as const });
const key = (target: ReportTarget) => `${target.kind}:${target.id}`;

/** Native producers own Access, container checks and display facts. A report or
 * its original revision is never used as current target disclosure evidence. */
export async function readReporterHistoryTargets(
  dependencies: ReportDependencies,
  targets: readonly ReportTarget[],
  context: Context,
): Promise<ReadonlyMap<string, ReporterTargetSummary>> {
  if (targets.length > 21) throw new RangeError('At most 21 report targets');
  const unique = [...new Map(targets.map((target) => [key(target), target])).values()];
  const output = new Map<string, ReporterTargetSummary>(unique.map((target) => [key(target), unavailable]));
  const readers = {
    pool: dependencies.pool, access: dependencies.access,
    tokens: { current: 1, keys: new Map([[1, dependencies.routeKey]]) },
  };
  const boards = unique.filter((target) => target.kind === 'board');
  const disclosedBoards = await readBoards(readers, boards.map((target) => target.id), context);
  boards.forEach((target, i) => {
    const board = disclosedBoards[i]?.value;
    if (board?.availability === 'available' && board.visibility !== 'taken_down')
      output.set(key(target), { state: 'available', label: board.title, href: `/v1/boards/${target.id}` });
  });
  const postHomes = new Map<number, string[]>();
  for (const target of unique.filter((target) => target.kind === 'post')) {
    const home = partitionOf(routeOf(target.id)!);
    const ids = postHomes.get(home) ?? [];
    ids.push(target.id);
    postHomes.set(home, ids);
  }
  const postThreads = new Map<string, string>();
  for (const ids of postHomes.values()) {
    const located = await snapshot(dependencies, ids[0]!, context, async (client) => {
      const parameters = { keys: JSON.stringify(ids.map((id) => ({ route: routeOf(id), id }))) };
      return (await client.query<{ post_id: string; thread_id: string }>(postLocations.sql,
        postLocations.params.map((name) => parameters[name as keyof typeof parameters]))).rows;
    });
    for (const row of located.value) {
      if (routeOf(row.post_id) === routeOf(row.thread_id)) postThreads.set(row.post_id, row.thread_id);
    }
  }
  const threadIds = [...new Set([
    ...unique.filter((target) => target.kind === 'thread').map((target) => target.id), ...postThreads.values(),
  ])];
  const disclosedThreads = await discloseThreads(readers, threadIds, context);
  const threads = new Map(threadIds.map((id, i) => [id, disclosedThreads[i]?.value]));
  for (const target of unique) {
    if (target.kind === 'thread') {
      const thread = threads.get(target.id);
      if (thread?.availability === 'available' && thread.visibility !== 'taken_down' && thread.firstPost.availability === 'available')
        output.set(key(target), { state: 'available', label: thread.title, href: `/v1/threads/${target.id}` });
    }
  }
  // The exact post driver also checks every reply ancestor; a readable first
  // post or thread alone can never authorize a reported reply.
  for (const ids of postHomes.values()) {
    for (const id of ids) {
      const threadId = postThreads.get(id);
      const thread = threadId ? threads.get(threadId) : null;
      if (!threadId || !thread || thread.availability !== 'available' || thread.visibility === 'taken_down') continue;
      const post = (await readPost(readers, threadId, id, context)).value;
      if (post?.availability === 'available' && post.visibility !== 'taken_down')
        output.set(`post:${id}`, { state: 'available', label: thread.title, href: `/v1/posts/${id}` });
    }
  }
  const subjects = unique.filter((target) => target.kind === 'subject');
  if (subjects.length) {
    const current = await readCurrentSubjectSummaries({ ...dependencies, ...context }, subjects.map((target) => target.id));
    await current.verify();
    for (const target of subjects) {
      const summary = current.summaries.get(target.id);
      // Keep exact native binding: redirects are not permission to link a report
      // against a different target, or to expose the concealed original.
      if (summary?.id === target.id)
        output.set(key(target), { state: 'available', label: summary.label?.value ?? null, href: `/v1/subjects/${target.id}` });
    }
  }
  return output;
}
