import {
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { AuthoringDepartureBoundary, AuthoringDepartureProvider } from '../threads/authoring-departure';
import { createPrivateReaderLifetime, type PrivateReaderNavigation } from './private-reader-lifetime';
import { Badge } from '@rezics/ui/shadcn/badge';
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
  appealNavigationContext,
  appealReadKey,
  type AppealReadInput,
  type AppealReadState,
  type PrivateAppealPage,
} from './appeals-read-model';
import { moderationTargetContent, type ModerationTarget } from './target-content';

const date = (value: string) =>
  new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));

const readAppeals = (input: AppealReadInput) => loadModerationAppeals({ data: input });
/** One explicit Next intent survives the route's keyed native-page replacement. */
export type AppealsContinuationFocus = {
  context: string;
  readKey: string;
  generation: string;
  isSessionCurrent: () => boolean;
};
type AppealsPageProps = {
  page: PrivateAppealPage;
  input: AppealReadInput;
  active?: boolean;
  navigation?: PrivateReaderNavigation;
  onNext?: (cursor: string) => void;
  onRestart?: () => void;
  reportsSearch?: string;
  continuationFocus?: RefObject<AppealsContinuationFocus | null>;
  read?: (input: AppealReadInput) => Promise<PrivateAppealPage>;
};
type LocalAppealReadFocus = {
  control: HTMLButtonElement;
  readKey: string;
  generation: string;
  ticket?: number;
  stop: () => void;
};

/** New native generations get new local state; old callbacks retain their original owner. */
export function ModerationAppealsPage(props: AppealsPageProps) {
  return <AppealsVisit key={props.page.generation} {...props} />;
}

function AppealsVisit(props: AppealsPageProps) {
  const router = useRouter({ warn: false });
  const client = useContext(QueryClientContext);
  const queueBoundary = useRef<HTMLElement>(null);
  const recoveryControl = useRef<HTMLButtonElement>(null);
  const localReadFocus = useRef<LocalAppealReadFocus | null>(null);
  const [original] = useState(() => ({ ...props, input: Object.freeze({ ...props.input }) }));
  const [owner] = useState(() =>
    client && typeof window !== 'undefined'
      ? createPrivateReaderLifetime(client, original.page, appealReadKey(original.input), original.navigation)
      : null,
  );
  const [data, setData] = useState(original.page);
  const reading = useRef(false);
  const unresolved = useRef(new Set<string>());
  const [refreshBlocked, setRefreshBlocked] = useState(false);
  const originalClient = useRef(client).current;
  function clearLocalReadFocus(expected?: LocalAppealReadFocus) {
    const intent = localReadFocus.current;
    if (!intent || (expected && intent !== expected)) return;
    localReadFocus.current = null;
    intent.stop();
  }
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
  function resolutionPending(appealId: string, pending: boolean) {
    if (!current()) return;
    if (pending) unresolved.current.add(appealId);
    else unresolved.current.delete(appealId);
    setRefreshBlocked(unresolved.current.size > 0);
  }
  async function reload(event?: ReactMouseEvent<HTMLButtonElement>) {
    clearLocalReadFocus();
    if (
      !current() ||
      reading.current ||
      unresolved.current.size > 0 ||
      (data.state !== 'ready' && data.state !== 'unavailable')
    )
      return;
    const control =
      event?.detail === 0 && typeof document !== 'undefined' && event.currentTarget === document.activeElement
        ? event.currentTarget
        : null;
    if (control) {
      const intent: LocalAppealReadFocus = {
        control,
        readKey: appealReadKey(original.input),
        generation: original.page.generation,
        ...(owner ? { ticket: owner.ticket() } : {}),
        stop: () => {},
      };
      const cancel = () => clearLocalReadFocus(intent);
      document.addEventListener('pointerdown', cancel, true);
      document.addEventListener('focusin', cancel, true);
      intent.stop = () => {
        document.removeEventListener('pointerdown', cancel, true);
        document.removeEventListener('focusin', cancel, true);
      };
      localReadFocus.current = intent;
    }
    reading.current = true;
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
      if (current() && (!owner || owner.owns(ticket!))) reading.current = false;
    }
  }
  const leave = (action: (() => void) | undefined) => {
    if (!current()) return;
    action?.();
  };
  const commandCurrent = owner ? () => !reading.current && owner.canCommand() : undefined;
  const state =
    (typeof window !== 'undefined' && !owner) || (owner && !owner.healthy())
      ? 'closed'
      : owner && !owner.available() && data.state === 'ready'
        ? 'unavailable'
        : data.state;
  useEffect(() => {
    const intent = props.continuationFocus?.current;
    if (!intent) return;
    if (!intent.isSessionCurrent()) {
      props.continuationFocus!.current = null;
      return;
    }
    if (intent.generation === original.page.generation) return;
    const matches =
      intent.readKey === appealReadKey(original.input) &&
      !!router &&
      intent.context === appealNavigationContext(router.state.location);
    // Hydrated private admission can finish after the replacement commits. An actual
    // failed page consumes the intent now, so a later retry cannot take focus.
    if (matches && data.state === 'ready' && owner?.healthy() && !owner.available()) return;
    const focus = () => {
      if (props.continuationFocus!.current !== intent) return;
      props.continuationFocus!.current = null;
      if (
        matches &&
        state === 'ready' &&
        data.generation === original.page.generation &&
        intent.isSessionCurrent() &&
        current() &&
        (!owner || owner.available())
      )
        queueBoundary.current?.focus();
    };
    // The shell also focuses on route resolution. Transfer after that convention,
    // or immediately when the admitted page commits after the route has resolved.
    if (!matches || state !== 'ready' || router?.state.status === 'idle') focus();
    else return router?.subscribe('onResolved', focus);
  });
  useEffect(() => {
    const intent = localReadFocus.current;
    if (!intent) return;
    if (
      !current() ||
      props.active === false ||
      props.page.generation !== intent.generation ||
      appealReadKey(props.input) !== intent.readKey ||
      appealReadKey(original.input) !== intent.readKey ||
      !appealPageIsCurrent(props.page, props.input) ||
      (owner && intent.ticket !== undefined && !owner.owns(intent.ticket)) ||
      (document.activeElement !== intent.control && document.activeElement !== document.body)
    ) {
      clearLocalReadFocus(intent);
      return;
    }
    if (data.state === 'loading') return;
    clearLocalReadFocus(intent);
    if (state === 'ready') queueBoundary.current?.focus();
    else if (state === 'unavailable') recoveryControl.current?.focus();
  });
  useEffect(() => () => clearLocalReadFocus(), []);
  return (
    <AuthoringDepartureProvider
      sessionBound={false}
      navigationContext={appealNavigationContext}
      onNavigationLeave={() => owner?.retire()}
    >
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
          queueBoundary={queueBoundary}
          {...(original.input.threadId ? { threadId: original.input.threadId } : {})}
          {...(original.input.postId ? { postId: original.input.postId } : {})}
          {...(props.reportsSearch !== undefined ? { reportsSearch: props.reportsSearch } : {})}
          {...(commandCurrent ? { isCurrent: commandCurrent } : {})}
          refreshBlocked={refreshBlocked}
          recoveryControl={recoveryControl}
          onResolutionPending={resolutionPending}
          onRefresh={(event) => void reload(event)}
          onRetry={(event) => void reload(event)}
          onNext={(cursor) => leave(() => props.onNext?.(cursor))}
          onRestart={() => leave(props.onRestart)}
        />
      </div>
    </AuthoringDepartureProvider>
  );
}
const emptySubscribe = () => () => {};
const zeroSnapshot = () => 0;

function currentTargetIsAvailable(
  target: ModerationTarget | undefined,
  identity: { kind: 'post' | 'thread'; id: string },
) {
  if (!target?.value || target.key !== `${identity.kind}:${identity.id}`) return false;
  const evidence = moderationEvidence(target.value);
  if (evidence) return evidence.kind === identity.kind && evidence.id === identity.id && evidence.state === 'available';
  if (typeof target.value !== 'object' || Array.isArray(target.value)) return false;
  const value = target.value as Record<string, unknown>;
  const raw = value[identity.kind] ?? value;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const resource = raw as Record<string, unknown>;
  if (
    (resource.id !== undefined && resource.id !== identity.id) ||
    (resource.availability !== undefined && resource.availability !== 'available') ||
    resource.removed
  )
    return false;
  const revision =
    resource.revision && typeof resource.revision === 'object' && !Array.isArray(resource.revision)
      ? (resource.revision as Record<string, unknown>)
      : resource;
  if ((revision.availability !== undefined && revision.availability !== 'available') || revision.removed) return false;
  if (identity.kind === 'post') {
    const body = revision.body ?? resource.body;
    return typeof body === 'string' || Boolean(body);
  }
  return true;
}

export function ModerationAppealsView(props: ComponentProps<typeof AppealsView>) {
  return (
    <AuthoringDepartureBoundary sessionBound={false} navigationContext={appealNavigationContext}>
      <AppealsView {...props} />
    </AuthoringDepartureBoundary>
  );
}

function AppealsView({
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
  onRefresh,
  refreshBlocked = false,
  onResolutionPending,
  onRestart,
  reportsSearch,
  isCurrent,
  queueBoundary,
  recoveryControl,
}: {
  queueBoundary?: RefObject<HTMLElement | null>;
  recoveryControl?: RefObject<HTMLButtonElement | null>;
  isCurrent?: () => boolean;
  state?: AppealReadState;
  onRetry?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onRefresh?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  refreshBlocked?: boolean;
  onResolutionPending?: (appealId: string, pending: boolean) => void;
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
  const headingId = useId();
  const router = useRouter({ warn: false });
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
    <article
      ref={queueBoundary}
      tabIndex={-1}
      aria-labelledby={headingId}
      className="max-w-4xl space-y-8 text-foreground"
    >
      <header className="space-y-3">
        <p className="text-sm text-muted-foreground">{m.moderation_appeals_tab()}</p>
        <PageHeading id={headingId}>{m.moderation_appeals_heading()}</PageHeading>
      </header>
      <nav aria-label={m.moderation_tabs_label()} className="flex gap-4 border-b pb-2">
        <a
          href={reportsHref}
          onClick={(event) => {
            if (
              !router ||
              event.defaultPrevented ||
              event.button !== 0 ||
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey
            )
              return;
            event.preventDefault();
            void router.navigate({ href: reportsHref });
          }}
        >
          {m.moderation_reports_tab()}
        </a>
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
      {state === 'ready' && onRefresh ? (
        <div className="space-y-2">
          <Button variant="outline" disabled={refreshBlocked} onClick={onRefresh}>
            {m.moderation_queue_refresh()}
          </Button>
          {refreshBlocked ? (
            <p role="status" className="text-sm text-muted-foreground">
              {m.moderation_appeals_refresh_blocked()}
            </p>
          ) : null}
        </div>
      ) : null}
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
            <Button ref={recoveryControl} variant="outline" onClick={onRetry}>
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
                {...(onResolutionPending ? { onResolutionPending } : {})}
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
  onResolutionPending,
}: {
  appeal: Appeal;
  target: ModerationTarget | undefined;
  mayResolve: boolean;
  isCurrent?: () => boolean;
  onResolutionPending?: (appealId: string, pending: boolean) => void;
}) {
  const id = useId();
  const identity = appealTarget(appeal);
  const appealKind =
    identity?.kind === 'post'
      ? m.moderation_queue_post()
      : identity?.kind === 'thread'
        ? m.moderation_queue_thread()
        : m.moderation_target_unavailable();
  const targetKind =
    identity?.kind === 'post'
      ? m.reporter_status_post()
      : identity?.kind === 'thread'
        ? m.reporter_status_thread()
        : m.moderation_target_unavailable();

  return (
    <li>
      <ContentItemFrame as="article" className="space-y-5 p-4 sm:p-6" aria-labelledby={`${id}-title`}>
        <header className="space-y-2">
          <ContentItemHeading id={`${id}-title`} level={2} className="text-lg font-semibold">
            {m.moderation_appeals_tab()} · {appealKind}
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
          <Badge variant="outline">{targetKind}</Badge>
          <blockquote className="min-w-0 border-l-2 pl-3 wrap-anywhere">{moderationTargetContent(target)}</blockquote>
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
            {...(onResolutionPending
              ? { onUnresolvedChange: (pending: boolean) => onResolutionPending(appeal.id, pending) }
              : {})}
            {...(isCurrent ? { isCurrent } : {})}
          />
          <details className="border-t border-border pt-3">
            <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium">
              {m.reporter_status_reference()}
            </summary>
            <ContentItemFrame as="div" className="space-y-4 p-4">
              <dl className="space-y-4 text-sm">
                <div className="space-y-1">
                  <dt className="text-muted-foreground">{m.moderation_case_details_appeal_id()}</dt>
                  <dd className="select-text break-all font-mono leading-6">{appeal.id}</dd>
                </div>
                <div className="space-y-1">
                  <dt className="text-muted-foreground">{m.moderation_case_details_decision_id()}</dt>
                  <dd className="select-text break-all font-mono leading-6">{appeal.decisionId}</dd>
                </div>
                {identity && currentTargetIsAvailable(target, identity) ? (
                  <div className="space-y-1">
                    <dt className="text-muted-foreground">{m.moderation_case_details_target_id()}</dt>
                    <dd className="select-text break-all font-mono leading-6">{identity.id}</dd>
                  </div>
                ) : null}
              </dl>
            </ContentItemFrame>
          </details>
        </div>
      </ContentItemFrame>
    </li>
  );
}
