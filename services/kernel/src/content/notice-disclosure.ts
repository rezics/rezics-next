import type { Pool } from 'pg';
import type { Access, Actor } from '../request/access.ts';
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

import { readNoticeActors, unavailableNoticeActor, type NoticeActor, type NoticeActorObservationReader } from './notice-actor-context.ts';
export type { NoticeActor } from './notice-actor-context.ts';

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
  noticeActorObservations?: NoticeActorObservationReader;
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
  const sourceObservations = new Map<
    string,
    {
      kind: 'decision' | 'report';
      epoch: number;
      id: string;
      target: { kind: string; id: string };
      threadId?: string | null;
    }
  >();

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
      sourceObservations.set(candidate.notice_id, {
        kind: 'report',
        epoch: report.anchor.epoch,
        id: report.value.id,
        target: report.value.target,
        threadId: report.value.threadId,
      });
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
      sourceObservations.set(candidate.notice_id, {
        kind: 'decision',
        epoch: decision.anchor.epoch,
        id: decision.value.id,
        target: { kind: decision.value.targetKind, id: decision.value.targetId },
      });
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
      : await readNoticeActors(dependencies.pool, actorIds, dependencies.deadline, dependencies.noticeActorObservations);

  // The first native source and target reads are the baseline. Re-read those same
  // keys after Account/Media composition so the presentation round cannot validate
  // an earlier target, report outcome, or author decision.
  const currentSourceIds = new Set<string>();
  for (const candidate of candidates) {
    if (!source.has(candidate.notice_id)) continue;
    const before = sourceObservations.get(candidate.notice_id);
    if (!before) {
      if (source.has(candidate.notice_id)) currentSourceIds.add(candidate.notice_id);
      continue;
    }
    if (before.kind === 'report' && candidate.report_id) {
      const after = await readReporterNoticeOutcome(
        {
          pool: dependencies.pool,
          access: dependencies.access,
          routeKey: dependencies.routeKey,
        },
        candidate.report_id as ReportId,
        { actor: dependencies.actor, deadline: dependencies.deadline },
      );
      if (
        after?.value &&
        after.anchor.epoch === before.epoch &&
        after.value.id === before.id &&
        after.value.reporterId === accountId &&
        after.value.outcome
      ) {
        currentSourceIds.add(candidate.notice_id);
        const originalTarget = source.get(candidate.notice_id)!;
        const sameTarget =
          after.value.target.kind === before.target.kind &&
          after.value.target.id === before.target.id &&
          after.value.threadId === before.threadId;
        if (sameTarget) {
          source.set(candidate.notice_id, {
            ...originalTarget,
            summary: after.value.outcome === 'actioned' ? 'your report was actioned' : 'your report was dismissed',
          });
        } else {
          const { ref: _ref, ...withoutPostContext } = originalTarget;
          source.set(candidate.notice_id, {
            ...withoutPostContext,
            summary: after.value.outcome === 'actioned' ? 'your report was actioned' : 'your report was dismissed',
          });
          sourceBoards.delete(candidate.notice_id);
        }
      }
    } else if (before.kind === 'decision' && candidate.decision_id) {
      const after = await readModerationDecisionForAuthor(
        { pool: dependencies.pool, access: dependencies.access },
        candidate.decision_id,
        { actor: dependencies.actor, deadline: dependencies.deadline },
      );
      if (
        after?.value &&
        after.anchor.epoch === before.epoch &&
        after.value.id === before.id &&
        after.value.id === candidate.decision_id
      ) {
        const appeal = after.value.appeal;
        const isAppeal = appeal?.id === candidate.source_id && appeal.outcome !== null;
        if (candidate.source_id === after.value.id || isAppeal) {
          currentSourceIds.add(candidate.notice_id);
          const originalTarget = source.get(candidate.notice_id)!;
          const sameTarget = after.value.targetKind === before.target.kind && after.value.targetId === before.target.id;
          const summary = isAppeal
            ? appeal.outcome === 'reversed'
              ? 'your appeal restored the content'
              : 'your appeal was upheld'
            : 'your content was taken down';
          if (sameTarget) source.set(candidate.notice_id, { ...originalTarget, summary });
          else {
            const { ref: _ref, ...withoutPostContext } = originalTarget;
            source.set(candidate.notice_id, { ...withoutPostContext, summary });
          }
        }
      }
    }
  }
  const currentContexts = await readNoticePostContexts(
    { pool: dependencies.pool, access: dependencies.access, tokens: dependencies.tokens },
    [...refs.values()],
    { actor: dependencies.actor, deadline: dependencies.deadline },
  );
  const currentBoardContexts = await readNoticeBoardContexts(
    { pool: dependencies.pool, access: dependencies.access, tokens: dependencies.tokens },
    [...boardRefs],
    { actor: dependencies.actor, deadline: dependencies.deadline },
  );
  const result = new Map<string, NoticeProjection>();
  const eligibleIds = new Set(
    candidates
      .filter((candidate) => {
        const disclosed = source.get(candidate.notice_id);
        if (!disclosed || !currentSourceIds.has(candidate.notice_id)) return false;
        const currentContext = disclosed.ref ? currentContexts.get(contextKey(disclosed.ref)) : undefined;
        const boardId = sourceBoards.get(candidate.notice_id);
        const currentBoard = boardId ? currentBoardContexts.get(boardId) : undefined;
        return (
          candidate.kind === 'moderation_decision' ||
          disclosed.reportId !== null ||
          !!currentContext ||
          (boardId !== undefined && !!currentBoard)
        );
      })
      .map((candidate) => candidate.notice_id),
  );
  for (const candidate of candidates) {
    if (!eligibleIds.has(candidate.notice_id)) continue;
    const disclosed = source.get(candidate.notice_id);
    if (!disclosed) continue;
    const context = disclosed.ref ? currentContexts.get(contextKey(disclosed.ref)) : undefined;
    const boardContext = sourceBoards.get(candidate.notice_id);
    const board = boardContext ? currentBoardContexts.get(boardContext) : undefined;
    const actor =
      candidate.kind === 'moderation_decision'
        ? ({ state: 'system', displayName: 'Moderation team', handle: null, avatar: null, avatarUrl: null } as const)
        : candidate.actor_id
          ? (actors.get(candidate.actor_id) ?? unavailableNoticeActor())
          : unavailableNoticeActor();
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
