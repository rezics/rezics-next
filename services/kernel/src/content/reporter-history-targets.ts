import type { Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { communityReportTargetFacts, communityReportReadCheck } from '../community/report-targets.ts';
import { readRealm } from '../community/realm.ts';
import { readSpaceForViewer } from '../community/space.ts';
import { readCurrentSubjectSummaries } from '../semantic/current-subject-summaries.ts';
import { discloseThreads, readBoards, readNoticePostContexts, snapshot } from './reads.ts';
import type { ReportDependencies, ReportTarget } from './reports.ts';
import postLocations from './reporter-history-posts.sql';

export type ReporterTargetSummary =
  | Readonly<{ state: 'available'; label: string | null; href: string }>
  | Readonly<{ state: 'unavailable' }>;
type Context = Readonly<{ actor: Actor; deadline: number }>;
const unavailable = Object.freeze({ state: 'unavailable' as const });
const key = (target: ReportTarget) => `${target.kind}:${target.id}`;
type TargetRead = Readonly<{
  summaries: ReadonlyMap<string, ReporterTargetSummary>;
  verify(): Promise<boolean>;
}>;
type CommunityTarget = Extract<ReportTarget, { kind: 'realm' | 'space' }>;
type CommunitySource = Readonly<{ epoch: number; fingerprint: string | null }>;

/** Native producers own Access, container checks and display facts. A report or
 * its original revision is never used as current target disclosure evidence. */
export async function readReporterHistoryTargets(
  dependencies: ReportDependencies,
  targets: readonly ReportTarget[],
  context: Context,
): Promise<TargetRead> {
  if (targets.length > 21) throw new RangeError('At most 21 report targets');
  const unique = [...new Map(targets.map((target) => [key(target), target])).values()];
  const initial = await observeTargets(dependencies, unique, context);
  return {
    summaries: initial.summaries,
    async verify() {
      const current = await observeTargets(dependencies, unique, context);
      return sameMap(initial.summaries, current.summaries) && sameMap(initial.communitySources, current.communitySources);
    },
  };
}

async function observeTargets(
  dependencies: ReportDependencies,
  unique: readonly ReportTarget[],
  context: Context,
): Promise<Readonly<{
  summaries: Map<string, ReporterTargetSummary>;
  communitySources: Map<string, CommunitySource>;
}>> {
  const output = new Map<string, ReporterTargetSummary>(unique.map((target) => [key(target), unavailable]));
  const communityTargets = unique.filter((target): target is CommunityTarget =>
    target.kind === 'realm' || target.kind === 'space',
  );
  const communitySources = await readCommunitySources(dependencies, communityTargets, context);
  const readers = {
    pool: dependencies.pool,
    access: dependencies.access,
    tokens: { current: 1, keys: new Map([[1, dependencies.routeKey]]) },
  };
  const boards = unique.filter((target) => target.kind === 'board');
  const disclosedBoards = await readBoards(
    readers,
    boards.map((target) => target.id),
    context,
  );
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
      return (
        await client.query<{ post_id: string; thread_id: string }>(
          postLocations.sql,
          postLocations.params.map((name) => parameters[name as keyof typeof parameters]),
        )
      ).rows;
    });
    for (const row of located.value) {
      if (routeOf(row.post_id) === routeOf(row.thread_id)) postThreads.set(row.post_id, row.thread_id);
    }
  }
  const threadIds = [
    ...new Set([
      ...unique.filter((target) => target.kind === 'thread').map((target) => target.id),
      ...postThreads.values(),
    ]),
  ];
  const disclosedThreads = await discloseThreads(readers, threadIds, context);
  const threads = new Map(threadIds.map((id, i) => [id, disclosedThreads[i]?.value]));
  for (const target of unique) {
    if (target.kind === 'thread') {
      const thread = threads.get(target.id);
      if (
        thread?.availability === 'available' &&
        thread.visibility !== 'taken_down' &&
        thread.firstPost.availability === 'available'
      )
        output.set(key(target), { state: 'available', label: thread.title, href: `/v1/threads/${target.id}` });
    }
  }
  // The compact native notice reader proves the exact post and every reply
  // ancestor without loading post bodies merely to reuse the thread label.
  const postContexts = await readNoticePostContexts(
    readers,
    [...postHomes.values()].flatMap((ids) =>
      ids.flatMap((id) => {
        const threadId = postThreads.get(id);
        return threadId ? [{ threadId, postId: id }] : [];
      }),
    ),
    context,
  );
  for (const ids of postHomes.values()) {
    for (const id of ids) {
      const threadId = postThreads.get(id);
      const post = threadId ? postContexts.get(`${threadId}/${id}`) : null;
      if (post) output.set(`post:${id}`, { state: 'available', label: post.threadTitle, href: `/v1/posts/${id}` });
    }
  }
  const subjects = unique.filter((target) => target.kind === 'subject');
  if (subjects.length) {
    const current = await readCurrentSubjectSummaries(
      { ...dependencies, ...context },
      subjects.map((target) => target.id),
    );
    await current.verify();
    for (const target of subjects) {
      const summary = current.summaries.get(target.id);
      // Keep exact native binding: redirects are not permission to link a report
      // against a different target, or to expose the concealed original.
      if (summary?.id === target.id)
        output.set(key(target), {
          state: 'available',
          label: summary.label?.value ?? null,
          href: `/v1/subjects/${target.id}`,
        });
    }
  }
  const at = (dependencies.clock?.() ?? new Date()).toISOString();
  for (const target of communityTargets) {
    if (!communitySources.get(key(target))?.fingerprint) continue;
    if (target.kind === 'realm') {
      const realm = await readRealm(dependencies, context.actor, target.id, context);
      if (realm?.state === 'active')
        output.set(key(target), { state: 'available', label: realm.title, href: `/v1/realms/${target.id}` });
    } else {
      const check = await communityReportReadCheck(dependencies, target, context);
      const space = await readSpaceForViewer(dependencies, context.actor, target.id, at, context, check);
      if (space?.state === 'active')
        output.set(key(target), { state: 'available', label: space.title, href: `/v1/spaces/${target.id}` });
    }
  }
  return { summaries: output, communitySources };
}

async function readCommunitySources(
  dependencies: ReportDependencies,
  targets: readonly CommunityTarget[],
  context: Context,
): Promise<Map<string, CommunitySource>> {
  const homes = new Map<number, CommunityTarget[]>();
  for (const target of targets) {
    const home = partitionOf(routeOf(target.id)!);
    const group = homes.get(home) ?? [];
    group.push(target);
    homes.set(home, group);
  }
  const sources = new Map<string, CommunitySource>();
  for (const group of homes.values()) {
    const observed = await snapshot(dependencies, group[0]!.id, context, async (client) => {
      const result = new Map<string, string | null>();
      for (const target of group) {
        const facts = await communityReportTargetFacts(client, target);
        result.set(key(target), facts?.fingerprint ?? null);
      }
      return result;
    });
    for (const [targetKey, fingerprint] of observed.value)
      sources.set(targetKey, { epoch: observed.anchor.epoch, fingerprint });
  }
  return sources;
}

function sameMap<T>(left: ReadonlyMap<string, T>, right: ReadonlyMap<string, T>): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (JSON.stringify(value) !== JSON.stringify(right.get(key))) return false;
  }
  return true;
}
