import type { Pool } from 'pg';
import { deadlineClient, within } from '../access/authenticate.ts';
import { withConnection } from '../database/pool.ts';
import { readPublicAccount, readPublicIdentities } from '../access/account-data.ts';
import type { Access, Actor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { ReportId } from './model.ts';
import { readModerationDecisionForAuthor } from './moderation-decisions.ts';
import {
  readNoticeBoardContexts,
  readNoticePostContexts,
  type NoticeBoardContext,
  type NoticePostContext,
  type NoticePostReference,
} from './reads.ts';
import { readReporterNoticeOutcome } from './reports.ts';

export type NoticeCandidate = Readonly<{
  notice_id: string;
  kind: 'reply' | 'mention' | 'thread_watch' | 'board_activity' | 'moderation_decision';
  created_at: Date | string;
  created_at_key: string;
  source_id: string | null;
  actor_id: string | null;
  thread_id: string | null;
  post_id: string | null;
  decision_id: string | null;
  report_id: string | null;
  unread: boolean;
}>;

export type NoticeActor =
  | Readonly<{
      state: 'available';
      accountId: string;
      displayName: string;
      handle: string | null;
      avatarUrl: string | null;
      automated: boolean;
    }>
  | Readonly<{ state: 'withheld'; displayName: 'Former or unavailable account'; handle: null; avatarUrl: null }>
  | Readonly<{ state: 'system'; displayName: 'Moderation team'; handle: null; avatarUrl: null }>;

export type NoticeTarget = Readonly<{
  state: 'available' | 'withheld';
  threadId: string | null;
  postId: string | null;
  boardId: string | null;
  threadTitle: string | null;
  boardTitle: string | null;
}>;

export type NoticeOpenAction =
  | Readonly<{ kind: 'board'; boardId: string }>
  | Readonly<{ kind: 'thread'; threadId: string }>
  | Readonly<{ kind: 'thread_post'; threadId: string; postId: string }>
  | Readonly<{ kind: 'moderation_decision'; decisionId: string }>
  | Readonly<{ kind: 'report_outcome'; reportId: string }>
  | null;

export type NoticeProjection = Readonly<{
  actor: NoticeActor;
  actorId: string | null;
  target: NoticeTarget;
  summary: string;
  open: NoticeOpenAction;
  decisionId: string | null;
  reportId: string | null;
}>;

export type NoticeDisclosureDependencies = Readonly<{
  pool: Pool;
  access: Access;
  tokens: KeyRing;
  routeKey: Uint8Array;
  actor: Actor;
  deadline: number;
}>;

const withheldTarget = (): NoticeTarget => ({
  state: 'withheld',
  threadId: null,
  postId: null,
  boardId: null,
  threadTitle: null,
  boardTitle: null,
});

function contextKey(reference: NoticePostReference): string {
  return `${reference.threadId}/${reference.postId ?? ''}`;
}

async function currentActors(
  pool: Pool,
  ids: readonly string[],
  deadline: number,
): Promise<ReadonlyMap<string, NoticeActor>> {
  const unique = [...new Set(ids.filter((id) => routeOf(id) !== null))];
  const output = new Map<string, NoticeActor>();
  if (unique.length === 0) return output;
  const routes = unique.map((id) => routeOf(id)!);
  const identities = await within(deadline, () =>
    withConnection(pool, async (connection) => {
      const client = deadlineClient(connection, deadline);
      const read = async () => {
        const rows = await readPublicIdentities(client, routes, unique);
        const byId = new Map(rows.map((identity) => [identity.id, identity]));
        const result = new Map<string, NoticeActor>();
        for (const [index, id] of unique.entries()) {
          const identity = byId.get(id);
          if (!identity || identity.state !== 'active' || identity.kind !== 'actor') continue;
          const profile = await readPublicAccount(client, routes[index]!, id);
          if (!profile || profile.state !== 'active' || profile.kind !== 'actor') continue;
          result.set(id, {
            state: 'available',
            accountId: id,
            displayName: profile.displayName?.trim() || profile.handle || 'Member',
            handle: profile.handle,
            avatarUrl: profile.avatarUrl,
            automated: identity.automated,
          });
        }
        return result;
      };
      const before = await read();
      const after = await read();
      const stable = new Map<string, NoticeActor>();
      for (const [id, current] of after) {
        if (JSON.stringify(before.get(id)) === JSON.stringify(current)) stable.set(id, current);
      }
      return stable;
    }),
  );
  for (const [id, actor] of identities) output.set(id, actor);
  return output;
}

function safeActor(): NoticeActor {
  return { state: 'withheld', displayName: 'Former or unavailable account', handle: null, avatarUrl: null };
}

function projectionTarget(context: NoticePostContext | undefined): NoticeTarget {
  return context
    ? {
        state: 'available',
        threadId: context.threadId,
        postId: context.postId,
        boardId: context.boardId,
        threadTitle: context.threadTitle,
        boardTitle: context.boardTitle,
      }
    : withheldTarget();
}

function projectionBoardTarget(context: NoticeBoardContext | undefined): NoticeTarget {
  return context
    ? {
        state: 'available',
        threadId: null,
        postId: null,
        boardId: context.boardId,
        threadTitle: null,
        boardTitle: context.boardTitle,
      }
    : withheldTarget();
}

/** Applies the closed, current per-kind disclosure table to one bounded candidate range. */
export async function discloseNoticeCandidates(
  dependencies: NoticeDisclosureDependencies,
  accountId: string,
  candidates: readonly NoticeCandidate[],
  options: Readonly<{ includeActors?: boolean; actorLimit?: number }> = {},
): Promise<ReadonlyMap<string, NoticeProjection>> {
  if (candidates.length > 200) throw new RangeError('At most 200 notice candidates');
  const actorLimit = options.actorLimit ?? 50;
  if (!Number.isInteger(actorLimit) || actorLimit < 0 || actorLimit > 50)
    throw new RangeError('At most 50 notice identities');
  const refs = new Map<string, NoticePostReference>();
  const boardRefs = new Set<string>();
  const source = new Map<
    string,
    {
      summary: string;
      ref?: NoticePostReference;
      open: NoticeOpenAction;
      decisionId: string | null;
      reportId: string | null;
    }
  >();
  const sourceBoards = new Map<string, string>();

  for (const candidate of candidates) {
    if (candidate.kind !== 'moderation_decision') {
      if (
        candidate.source_id !== candidate.post_id ||
        !candidate.thread_id ||
        !candidate.post_id ||
        routeOf(candidate.thread_id) === null ||
        routeOf(candidate.thread_id) !== routeOf(candidate.post_id)
      )
        continue;
      const ref = { threadId: candidate.thread_id, postId: candidate.post_id } satisfies NoticePostReference;
      refs.set(contextKey(ref), ref);
      source.set(candidate.notice_id, {
        summary:
          candidate.kind === 'reply'
            ? 'replied in a discussion'
            : candidate.kind === 'mention'
              ? 'mentioned you'
              : candidate.kind === 'thread_watch'
                ? 'new activity in a watched discussion'
                : 'new activity on a watched board',
        ref,
        open: { kind: 'thread_post', threadId: candidate.thread_id, postId: candidate.post_id },
        decisionId: null,
        reportId: null,
      });
      continue;
    }

    if (candidate.report_id) {
      if (candidate.source_id !== candidate.report_id) continue;
      const report = await readReporterNoticeOutcome(
        {
          pool: dependencies.pool,
          access: dependencies.access,
          routeKey: dependencies.routeKey,
        },
        candidate.report_id as ReportId,
        { actor: dependencies.actor, deadline: dependencies.deadline },
      );
      if (!report?.value || report.value.reporterId !== accountId || !report.value.outcome) continue;
      let ref: NoticePostReference | undefined;
      if (report.value.target.kind === 'board') {
        boardRefs.add(report.value.target.id);
        sourceBoards.set(candidate.notice_id, report.value.target.id);
      }
      if (report.value.threadId && ['post', 'thread'].includes(report.value.target.kind)) {
        ref = {
          threadId: report.value.threadId,
          postId: report.value.target.kind === 'post' ? report.value.target.id : null,
        };
        refs.set(contextKey(ref), ref);
      }
      source.set(candidate.notice_id, {
        summary: report.value.outcome === 'actioned' ? 'your report was actioned' : 'your report was dismissed',
        ...(ref ? { ref } : {}),
        open: { kind: 'report_outcome', reportId: report.value.id },
        decisionId: null,
        reportId: report.value.id,
      });
      continue;
    }

    if (candidate.decision_id) {
      const decision = await readModerationDecisionForAuthor(
        { pool: dependencies.pool, access: dependencies.access },
        candidate.decision_id,
        { actor: dependencies.actor, deadline: dependencies.deadline },
      );
      if (!decision?.value || decision.value.id !== candidate.decision_id) continue;
      const appeal = decision.value.appeal;
      if (candidate.source_id !== decision.value.id && (!appeal || candidate.source_id !== appeal.id)) continue;
      const isAppeal = appeal?.id === candidate.source_id && appeal.outcome !== null;
      if (candidate.source_id !== decision.value.id && !isAppeal) continue;
      let ref: NoticePostReference | undefined;
      if (decision.value.targetKind === 'thread' && candidate.thread_id === decision.value.targetId) {
        ref = { threadId: candidate.thread_id, postId: null };
      } else if (
        decision.value.targetKind === 'post' &&
        candidate.post_id === decision.value.targetId &&
        candidate.thread_id
      ) {
        ref = { threadId: candidate.thread_id, postId: candidate.post_id };
      } else {
        continue;
      }
      refs.set(contextKey(ref), ref);
      const summary = isAppeal
        ? appeal.outcome === 'reversed'
          ? 'your appeal restored the content'
          : 'your appeal was upheld'
        : 'your content was taken down';
      source.set(candidate.notice_id, {
        summary,
        ref,
        open: { kind: 'moderation_decision', decisionId: decision.value.id },
        decisionId: decision.value.id,
        reportId: null,
      });
      continue;
    }

    // Older delivered moderation envelopes intentionally disclose only that an
    // outcome exists; never infer a target or actor from their raw identifiers.
    if (candidate.thread_id === null && candidate.post_id === null) {
      source.set(candidate.notice_id, {
        summary: 'a moderation outcome was recorded',
        open: null,
        decisionId: null,
        reportId: null,
      });
    }
  }

  const contexts = await readNoticePostContexts(
    { pool: dependencies.pool, access: dependencies.access, tokens: dependencies.tokens },
    [...refs.values()],
    { actor: dependencies.actor, deadline: dependencies.deadline },
  );
  const boardContexts = await readNoticeBoardContexts(
    { pool: dependencies.pool, access: dependencies.access, tokens: dependencies.tokens },
    [...boardRefs],
    { actor: dependencies.actor, deadline: dependencies.deadline },
  );
  const eligible = candidates.filter((candidate) => {
    const disclosed = source.get(candidate.notice_id);
    const boardId = sourceBoards.get(candidate.notice_id);
    return (
      !!disclosed &&
      (candidate.kind === 'moderation_decision' ||
        disclosed.reportId !== null ||
        !!(disclosed.ref && contexts.has(contextKey(disclosed.ref))) ||
        !!(boardId && boardContexts.has(boardId)))
    );
  });
  const actorIds = eligible
    .slice(0, actorLimit)
    .flatMap((candidate) => (candidate.actor_id ? [candidate.actor_id] : []));
  const actors =
    options.includeActors === false
      ? new Map<string, NoticeActor>()
      : await currentActors(dependencies.pool, actorIds, dependencies.deadline);
  const result = new Map<string, NoticeProjection>();
  const eligibleIds = new Set(eligible.map((candidate) => candidate.notice_id));
  for (const candidate of candidates) {
    if (!eligibleIds.has(candidate.notice_id)) continue;
    const disclosed = source.get(candidate.notice_id);
    if (!disclosed) continue;
    const context = disclosed.ref ? contexts.get(contextKey(disclosed.ref)) : undefined;
    const boardContext = sourceBoards.get(candidate.notice_id);
    const board = boardContext ? boardContexts.get(boardContext) : undefined;
    const actor =
      candidate.kind === 'moderation_decision'
        ? ({ state: 'system', displayName: 'Moderation team', handle: null, avatarUrl: null } as const)
        : candidate.actor_id
          ? (actors.get(candidate.actor_id) ?? safeActor())
          : safeActor();
    result.set(candidate.notice_id, {
      actor,
      actorId: actor.state === 'available' ? actor.accountId : null,
      target: boardContext ? projectionBoardTarget(board) : projectionTarget(context),
      summary: disclosed.summary,
      open:
        context || board || disclosed.open?.kind === 'moderation_decision' || disclosed.open?.kind === 'report_outcome'
          ? disclosed.open
          : null,
      decisionId: disclosed.decisionId,
      reportId: disclosed.reportId,
    });
  }
  return result;
}
