import { useContext, useId, useRef, useState, useSyncExternalStore } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { createPrivateReaderLifetime, type PrivateReaderNavigation } from './private-reader-lifetime';
import { Button } from '@rezics/ui/shadcn/button';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { useSession } from '../session/query';
import { moderationEvidence } from './target-context';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PageHeading } from '../shell/page-heading';
import { AppealResolution } from './appeal-resolution';
import { appealTarget, loadModerationAppeals, type Appeal } from './appeals-read';
import {
  appealPageIsCurrent,
  appealReadKey,
  type AppealReadInput,
  type AppealReadState,
  type PrivateAppealPage,
} from './appeals-read-model';
import { moderationTargetContent, type ModerationTarget } from './target-content';

const date = (value: string) =>
  new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));

const readAppeals = (input: AppealReadInput) => loadModerationAppeals({ data: input });
type AppealsPageProps = {
  page: PrivateAppealPage;
  input: AppealReadInput;
  active?: boolean;
  navigation?: PrivateReaderNavigation;
  onNext?: (cursor: string) => void;
  onRestart?: () => void;
  reportsSearch?: string;
  read?: (input: AppealReadInput) => Promise<PrivateAppealPage>;
};

/** New native generations get new local state; old callbacks retain their original owner. */
export function ModerationAppealsPage(props: AppealsPageProps) {
  return <AppealsVisit key={props.page.generation} {...props} />;
}

function AppealsVisit(props: AppealsPageProps) {
  const client = useContext(QueryClientContext);
  const [original] = useState(() => ({ ...props, input: Object.freeze({ ...props.input }) }));
  const [owner] = useState(() =>
    client && typeof window !== 'undefined'
      ? createPrivateReaderLifetime(client, original.page, appealReadKey(original.input), original.navigation)
      : null,
  );
  const [data, setData] = useState(original.page);
  const retrying = useRef(false);
  const originalClient = useRef(client).current;
  if (
    props.active === false ||
    client !== originalClient ||
    props.navigation !== original.navigation ||
    props.read !== original.read ||
    !appealPageIsCurrent(props.page, props.input) ||
    appealReadKey(props.input) !== appealReadKey(original.input)
  )
    owner?.retire();
  useSyncExternalStore(owner?.subscribe ?? emptySubscribe, owner?.snapshot ?? zeroSnapshot, zeroSnapshot);
  const current = () => (owner ? owner.isCurrent() : typeof window === 'undefined');
  async function retry() {
    if (!current() || retrying.current || data.state !== 'unavailable') return;
    retrying.current = true;
    const ticket = owner?.ticket();
    setData({ ...data, appeals: [], targets: [], next: null, state: 'loading' });
    try {
      const result = await (original.read ?? readAppeals)(original.input);
      if (!current() || (owner && !owner.owns(ticket!))) return;
      if (!appealPageIsCurrent(result, original.input)) return owner?.retire();
      if (result.state === 'unavailable' && !result.readerOrigin) {
        setData({ ...result, appeals: [], targets: [], next: null });
      } else if (!owner || (await owner.accepts(result))) {
        if (current() && (!owner || owner.owns(ticket!))) setData(result);
      } else {
        owner.retire();
      }
    } catch {
      if (current() && (!owner || owner.owns(ticket!)))
        setData({ ...data, appeals: [], targets: [], next: null, state: 'unavailable' });
    } finally {
      if (current() && (!owner || owner.owns(ticket!))) retrying.current = false;
    }
  }
  const leave = (action: (() => void) | undefined) => {
    if (!current()) return;
    owner?.retire();
    action?.();
  };
  const commandCurrent = owner?.canCommand;
  const state =
    (typeof window !== 'undefined' && !owner) || (owner && !owner.healthy())
      ? 'closed'
      : owner && !owner.available() && data.state === 'ready'
        ? 'unavailable'
        : data.state;
  return (
    <div
      onClickCapture={(event) => {
        if ((event.target as Element).closest('a') && !current()) event.preventDefault();
      }}
    >
      <ModerationAppealsView
        key={data.generation}
        appeals={data.appeals}
        targets={data.targets}
        next={data.next}
        {...(data.viewerId !== null ? { viewerId: data.viewerId } : {})}
        state={state}
        {...(original.input.threadId ? { threadId: original.input.threadId } : {})}
        {...(original.input.postId ? { postId: original.input.postId } : {})}
        {...(original.reportsSearch !== undefined ? { reportsSearch: original.reportsSearch } : {})}
        {...(commandCurrent ? { isCurrent: commandCurrent } : {})}
        onRetry={() => void retry()}
        onNext={(cursor) => leave(() => original.onNext?.(cursor))}
        onRestart={() => leave(original.onRestart)}
      />
    </div>
  );
}
const emptySubscribe = () => () => {};
const zeroSnapshot = () => 0;

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
  isCurrent,
}: {
  isCurrent?: () => boolean;
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
        <ContentItemFrame
          as="div"
          role="status"
          aria-live="polite"
          aria-busy={state === 'loading'}
          className="space-y-3 p-4 sm:p-6"
        >
          <ContentItemHeading level={2} className="text-base font-semibold">
            {state === 'loading'
              ? m.moderation_appeals_read_loading()
              : state === 'unavailable'
                ? m.moderation_appeals_read_unavailable()
                : state === 'stale'
                  ? m.moderation_appeals_read_stale()
                  : m.moderation_appeals_read_closed()}
          </ContentItemHeading>
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
        </ContentItemFrame>
      ) : appeals.length ? (
        <ol className="space-y-4">
          {appeals.map((appeal) => {
            const identity = appealTarget(appeal);
            const target = targets.find((item) => item.key === `${identity?.kind}:${identity?.id}`);
            const mayResolve =
              (appeal.canResolve === true || (appeal.canResolve === undefined && canResolve?.(appeal) === true)) &&
              (!viewerId || viewerId !== appeal.decision.deciderId) &&
              (canResolve?.(appeal) ?? true);
            return (
              <AppealCard
                key={appeal.id}
                appeal={appeal}
                target={target}
                mayResolve={mayResolve}
                {...(isCurrent ? { isCurrent } : {})}
              />
            );
          })}
        </ol>
      ) : (
        <ContentItemFrame as="div" role="status" className="p-4 sm:p-6">
          <ContentItemHeading level={2} className="text-base font-semibold text-muted-foreground">
            {next ? m.moderation_appeals_read_sparse() : m.moderation_appeals_empty()}
          </ContentItemHeading>
        </ContentItemFrame>
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
  isCurrent,
}: {
  appeal: Appeal;
  target: ModerationTarget | undefined;
  mayResolve: boolean;
  isCurrent?: () => boolean;
}) {
  const id = useId();
  const identity = appealTarget(appeal);
  const targetKind =
    identity?.kind === 'post'
      ? m.moderation_queue_post()
      : identity?.kind === 'thread'
        ? m.moderation_queue_thread()
        : m.moderation_target_unavailable();

  return (
    <li>
      <ContentItemFrame as="article" className="space-y-5 p-4 sm:p-6" aria-labelledby={`${id}-title`}>
        <header className="space-y-2">
          <ContentItemHeading id={`${id}-title`} level={2} className="text-lg font-semibold">
            {m.moderation_appeals_tab()} · {targetKind}
          </ContentItemHeading>
          <p className="text-sm text-muted-foreground">
            {m.moderation_queue_submitted()} <time dateTime={appeal.createdAt}>{date(appeal.createdAt)}</time>
          </p>
        </header>
        <section aria-labelledby={`${id}-decision`} className="space-y-2">
          <ContentItemHeading id={`${id}-decision`} level={3} className="text-sm font-semibold">
            {m.moderation_appeal_decision_label()}
          </ContentItemHeading>
          <p className="whitespace-pre-wrap break-words">{appeal.decision.statement}</p>
        </section>
        <section aria-labelledby={`${id}-target`} className="space-y-2">
          <ContentItemHeading id={`${id}-target`} level={3} className="text-sm font-semibold">
            {m.moderation_current_target_label()}
          </ContentItemHeading>
          {identity ? (
            <p className="text-xs text-muted-foreground">
              <span>{m.moderation_appeal_target_label()}:</span> {targetKind}{' '}
              <code className="break-all">{identity.id}</code>
            </p>
          ) : null}
          <blockquote className="min-w-0 border-l-2 pl-3">{moderationTargetContent(target)}</blockquote>
        </section>
        <section aria-labelledby={`${id}-statement`} className="space-y-2">
          <ContentItemHeading id={`${id}-statement`} level={3} className="text-sm font-semibold">
            {m.moderation_appeal_reason_label()}
          </ContentItemHeading>
          <p className="whitespace-pre-wrap break-words">{appeal.statement}</p>
        </section>
        <div className="space-y-3 border-t pt-4">
          {appeal.decision.appeal ? (
            <p className="text-sm text-muted-foreground">
              {m.moderation_queue_resolved_at()}{' '}
              <time dateTime={appeal.decision.appeal.resolvedAt}>{date(appeal.decision.appeal.resolvedAt)}</time>
            </p>
          ) : null}
          <AppealResolution
            appealId={appeal.id}
            mayResolve={mayResolve}
            resolution={appeal.decision.appeal ?? null}
            {...(isCurrent ? { isCurrent } : {})}
          />
        </div>
      </ContentItemFrame>
    </li>
  );
}
