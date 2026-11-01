import { useEffect, useRef, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { useSession } from '../session/query';
import { moderationEvidence } from './target-context';
import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';
import { AppealResolution } from './appeal-resolution';
import { appealTarget, loadModerationAppeals, type Appeal } from './appeals-read';
import {
  appealPageIsCurrent,
  createAppealReadLifetime,
  type AppealReadInput,
  type AppealReadState,
  type PrivateAppealPage,
} from './appeals-read-model';
import { moderationTargetContent, type ModerationTarget } from './target-content';

/** Default route composition; retries replace only this private read, never replay a command. */
export function ModerationAppealsPage({
  page,
  input,
  active = true,
  onNext,
  onRestart,
  reportsSearch,
  read = (input) => loadModerationAppeals({ data: input }),
}: {
  page: PrivateAppealPage;
  input: AppealReadInput;
  active?: boolean;
  onNext?: (cursor: string) => void;
  onRestart?: () => void;
  reportsSearch?: string;
  read?: (input: AppealReadInput) => Promise<PrivateAppealPage>;
}) {
  const session = useSession();
  const [data, setData] = useState(page);
  const [lifetime] = useState(createAppealReadLifetime);
  const preparedViewer = data.viewerId ?? page.viewerId;
  const expectedViewer = preparedViewer ?? (session.state === 'signed-in' ? (session.subject ?? null) : null);
  lifetime.observeViewer(preparedViewer, session);
  if (!active || !appealPageIsCurrent(page, input)) lifetime.retire();
  const retrying = useRef(false);
  // Invalidate outstanding callbacks on unmount, including Strict Mode effect replay.
  useEffect(
    () => () => {
      lifetime.begin();
    },
    [lifetime],
  );

  async function retry() {
    if (lifetime.retired || retrying.current || data.state !== 'unavailable') return;
    retrying.current = true;
    const token = lifetime.begin();
    setData({ ...data, appeals: [], targets: [], next: null, state: 'loading' });
    try {
      const result = await read(input);
      if (!lifetime.isCurrent(token)) return;
      if (lifetime.accepts(token, result, input, expectedViewer)) setData(result);
      else if (appealPageIsCurrent(result, input) && result.viewerId === null && result.state !== 'ready')
        setData({ ...result, viewerId: expectedViewer });
      else {
        lifetime.retire();
        setData({ ...data, appeals: [], targets: [], next: null, state: 'closed' });
      }
    } catch {
      if (lifetime.isCurrent(token)) setData({ ...data, appeals: [], targets: [], next: null, state: 'unavailable' });
    } finally {
      retrying.current = false;
    }
  }
  const leave = (action: (() => void) | undefined) => {
    lifetime.retire();
    setData({ ...data, appeals: [], targets: [], next: null, state: 'loading' });
    action?.();
  };
  return (
    <ModerationAppealsView
      key={data.generation}
      appeals={data.appeals}
      targets={data.targets}
      next={data.next}
      {...(data.viewerId !== null ? { viewerId: data.viewerId } : {})}
      state={lifetime.retired ? (lifetime.viewerRetired || data.state === 'closed' ? 'closed' : 'loading') : data.state}
      {...(input.threadId ? { threadId: input.threadId } : {})}
      {...(input.postId ? { postId: input.postId } : {})}
      {...(reportsSearch !== undefined ? { reportsSearch } : {})}
      {...(expectedViewer !== null ? { onRetry: () => void retry() } : {})}
      onNext={(cursor) => leave(() => onNext?.(cursor))}
      onRestart={() => leave(onRestart)}
    />
  );
}

export function ModerationAppealsView({
  appeals,
  targets,
  next,
  threadId,
  postId,
  onNext,
  viewerId,
  canResolve,
  state = 'ready',
  onRetry,
  onRestart,
  reportsSearch,
}: {
  state?: AppealReadState;
  onRetry?: () => void;
  onRestart?: () => void;
  reportsSearch?: string;
  appeals: Appeal[];
  targets: ModerationTarget[];
  next: string | null;
  threadId?: string;
  postId?: string;
  onNext?: (cursor: string) => void;
  viewerId?: string;
  canResolve?: (appeal: Appeal) => boolean;
}) {
  const session = useSession();
  const evidence = targets.map((target) => moderationEvidence(target.value));
  if (
    session.state !== 'unknown' &&
    ((viewerId !== undefined && (session.state !== 'signed-in' || session.subject !== viewerId)) ||
      evidence.some((item) => item && (session.state !== 'signed-in' || session.subject !== item.viewerId)))
  )
    state = 'closed';
  const filters = [
    threadId ? `thread=${encodeURIComponent(threadId)}` : '',
    postId ? `post=${encodeURIComponent(postId)}` : '',
  ]
    .filter(Boolean)
    .join('&');
  const reportsHref = reportsSearch ?? (filters ? `?${filters}` : '?');
  return (
    <article className="max-w-4xl space-y-8 text-foreground">
      <header className="space-y-3">
        <p className="text-sm text-muted-foreground">{m.moderation_appeals_tab()}</p>
        <PageHeading>{m.moderation_appeals_heading()}</PageHeading>
      </header>
      <nav aria-label={m.moderation_tabs_label()} className="flex gap-4 border-b pb-2">
        <a href={reportsHref}>{m.moderation_reports_tab()}</a>
        <span aria-current="page" className="font-semibold">
          {m.moderation_appeals_tab()}
        </span>
      </nav>
      <p className="text-sm text-muted-foreground">
        {postId
          ? threadId
            ? m.moderation_appeals_read_post_thread_scope()
            : m.moderation_appeals_read_post_board_scope()
          : threadId
            ? m.moderation_appeals_read_thread_scope()
            : m.moderation_appeals_read_board_scope()}
      </p>
      {state !== 'ready' ? (
        <section className="space-y-3" aria-live="polite" aria-busy={state === 'loading'}>
          <p role="status">
            {state === 'loading'
              ? m.moderation_appeals_read_loading()
              : state === 'unavailable'
                ? m.moderation_appeals_read_unavailable()
                : state === 'stale'
                  ? m.moderation_appeals_read_stale()
                  : m.moderation_appeals_read_closed()}
          </p>
          {state === 'unavailable' && onRetry ? (
            <Button variant="outline" onClick={onRetry}>
              {m.moderation_appeals_read_retry()}
            </Button>
          ) : null}
          {state === 'stale' && onRestart ? (
            <Button variant="outline" onClick={onRestart}>
              {m.moderation_appeals_read_restart()}
            </Button>
          ) : null}
        </section>
      ) : appeals.length ? (
        <ol className="space-y-4">
          {appeals.map((appeal) => {
            const identity = appealTarget(appeal);
            const target = targets.find((item) => item.key === `${identity?.kind}:${identity?.id}`);
            const mayResolve =
              (appeal.canResolve === true || (appeal.canResolve === undefined && canResolve?.(appeal) === true)) &&
              (!viewerId || viewerId !== appeal.decision.deciderId) &&
              (canResolve?.(appeal) ?? true);
            return <AppealCard key={appeal.id} appeal={appeal} target={target} mayResolve={mayResolve} />;
          })}
        </ol>
      ) : (
        <p role="status" className="text-muted-foreground">
          {next ? m.moderation_appeals_read_sparse() : m.moderation_appeals_empty()}
        </p>
      )}
      {state === 'ready' && next ? (
        <Button variant="outline" onClick={() => onNext?.(next)}>
          {m.threads_next_page()}
        </Button>
      ) : null}
    </article>
  );
}

function AppealCard({
  appeal,
  target,
  mayResolve,
}: {
  appeal: Appeal;
  target: ModerationTarget | undefined;
  mayResolve: boolean;
}) {
  const identity = appealTarget(appeal);

  return (
    <li className="space-y-3 rounded-lg border p-4">
      <section className="space-y-2">
        <p className="whitespace-pre-wrap text-sm text-muted-foreground">
          <span className="font-medium">{m.moderation_appeal_decision_label()}:</span> {appeal.decision.statement}
        </p>
        <blockquote className="min-w-0 border-l-2 pl-3">{moderationTargetContent(target)}</blockquote>
        {identity ? (
          <p className="text-xs text-muted-foreground">
            <span>{m.moderation_appeal_target_label()}:</span> {identity.kind} <code>{identity.id}</code>
          </p>
        ) : null}
      </section>
      <p className="whitespace-pre-wrap">
        <span className="font-medium">{m.moderation_appeal_reason_label()}:</span> {appeal.statement}
      </p>
      <AppealResolution appealId={appeal.id} mayResolve={mayResolve} resolution={appeal.decision.appeal ?? null} />
    </li>
  );
}
