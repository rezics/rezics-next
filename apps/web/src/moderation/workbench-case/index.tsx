import { QueryClientContext } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import {
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { m } from '../../paraglide/messages.js';
import { localizeHref } from '../../paraglide/runtime.js';
import { csrfHeaders } from '../../threads/composer';
import { AuthoringDepartureBoundary, useAuthoringDeparture } from '../../threads/authoring-departure';
import { actionOnReport } from '../actions';
import { createReportsBulkAction, type ReportsBulkAction } from '../reports-bulk-action';
import type { PrivateReportPage, Report, ReportReadInput, ReportTargetValue } from '../reports-read';
import { reportPageIsCurrent, reportReadKey } from '../reports-read';
import type { ReportQueueAction } from '../reports-view-action';
import { ReportReviewCard } from '../reports-view-card';
import { createPrivateReaderLifetime } from '../private-reader-lifetime';
import type { ReportNavigation } from '../reports-page';
import { reportReviewDepartureMessages, reportReviewNavigationContext } from '../reports-bulk-controls';
import { workbenchCaseFromPage, workbenchCaseQueueHref, type WorkbenchCaseSearch } from './read-model';
import { getLocale } from '../../paraglide/runtime.js';
import { workbenchQueueWindowHistory } from '../workbench-queue/window-history';

const nativeReportAction: ReportQueueAction = (data) => actionOnReport({ data, headers: csrfHeaders() });

export type WorkbenchCasePageProps = {
  page: PrivateReportPage;
  reportId: string;
  input: ReportReadInput;
  search?: WorkbenchCaseSearch;
  navigation?: ReportNavigation & { visitId?: string };
  active?: boolean;
  onAction?: ReportQueueAction;
  onRefresh?: () => Promise<void>;
  onRetry?: () => void;
  onRestart?: () => void;
  onReturnQueue?: (href: string) => void;
};

type WorkbenchVisit = ReturnType<typeof createVisit>;

function createVisit(original: WorkbenchCasePageProps, client: QueryClient | undefined) {
  const owner =
    typeof window === 'undefined' || !client
      ? undefined
      : createPrivateReaderLifetime(client, original.page, reportReadKey(original.input), original.navigation);
  let retired = false;
  let connected = true;
  const listeners = new Set<() => void>();
  const controllers = new Set<ReportsBulkAction>();
  const retire = () => {
    if (retired) return;
    retired = true;
    owner?.retire();
    for (const controller of controllers) controller.retire();
    controllers.clear();
    for (const listener of listeners) listener();
  };
  const observe = () => {
    if (owner && !owner.healthy()) retire();
    if (original.navigation?.isCurrent() === false) retire();
    return retired;
  };
  const isCurrent = () => connected && !observe() && (!owner || owner.isCurrent());
  return {
    page: original.page,
    input: original.input,
    reportId: original.reportId,
    client,
    navigation: original.navigation,
    owner,
    retire,
    observe,
    isCurrent,
    register(controller: ReportsBulkAction) {
      if (retired) controller.retire();
      else controllers.add(controller);
      return () => {
        controllers.delete(controller);
      };
    },
    subscribe(listener: () => void) {
      connected = true;
      listeners.add(listener);
      const disconnectOwner = owner?.subscribe(() => {
        observe();
        for (const current of listeners) current();
      });
      const disconnectNavigation = !owner ? original.navigation?.subscribe(retire) : undefined;
      observe();
      return () => {
        connected = false;
        listeners.delete(listener);
        disconnectOwner?.();
        disconnectNavigation?.();
        queueMicrotask(() => {
          if (!connected) retire();
        });
      };
    },
  };
}

export function WorkbenchCasePage(props: WorkbenchCasePageProps) {
  const client = useContext(QueryClientContext);
  const browserClient = typeof window !== 'undefined' ? client : undefined;
  const windowHistory = useMemo(() => (browserClient ? workbenchQueueWindowHistory(browserClient) : undefined), [browserClient]);
  const visit = useRef<WorkbenchVisit | null>(null);
  const previous = visit.current;
  if (!previous || previous.page.generation !== props.page.generation) {
    previous?.retire();
    visit.current = createVisit(props, client);
  }
  const current = visit.current!;
  if (
    current.page.state !== props.page.state ||
    current.page.readKey !== props.page.readKey ||
    current.client !== client ||
    current.navigation !== props.navigation ||
    props.active === false ||
    !reportPageIsCurrent(props.page, props.input)
  )
    current.retire();
  const readerVersion = useSyncExternalStore(
    current.subscribe,
    () => current.owner?.snapshot() ?? Number(current.observe()),
    () => 0,
  );

  useLayoutEffect(() => {
    if (
      current.isCurrent() &&
      props.active !== false &&
      props.search &&
      current.owner?.available() !== false &&
      reportPageIsCurrent(props.page, props.input)
    ) {
      windowHistory?.admitCase({
        visitId: props.navigation?.visitId,
        page: props.page,
        search: props.search,
        reportId: props.reportId,
        locale: getLocale(),
      });
    }
  }, [current, props.active, props.input, props.navigation?.visitId, props.page, props.reportId, props.search, readerVersion, windowHistory]);

  function returnToQueue(source?: HTMLElement) {
    if (!props.onReturnQueue) return;
    if (props.search && current.isCurrent())
      windowHistory?.beginCaseReturn({
        visitId: props.navigation?.visitId,
        page: props.page,
        search: props.search,
        reportId: props.reportId,
        locale: getLocale(),
        source,
      });
    props.onReturnQueue(queueHref);
  }

  const retired = current.observe();
  const queueHref = localizeHref(workbenchCaseQueueHref(props.search ?? props.input));
  if (retired || (typeof window !== 'undefined' && !browserClient) || (current.owner && !current.owner.available()))
    return <WorkbenchCaseStatus state="unavailable" queueHref={queueHref} onReturnQueue={props.onReturnQueue ? returnToQueue : undefined} />;

  const result = workbenchCaseFromPage(props.page, props.reportId);
  if (result.state !== 'ready')
    return (
      <WorkbenchCaseStatus
        state={result.state}
        queueHref={queueHref}
        {...(props.onRetry ? { onRetry: props.onRetry } : {})}
        {...(props.onRestart ? { onRestart: props.onRestart } : {})}
        {...(props.onReturnQueue ? { onReturnQueue: returnToQueue } : {})}
      />
    );

  const currentPage = current;
  return (
    <WorkbenchCaseDetail
      report={result.report}
      target={result.target}
      revision={result.revision}
      {...(current.page.inspection
        ? {
            reportedRevisionState: current.page.inspection.reportedRevisionState,
            actionAdvice: {
              dismiss: current.page.inspection.canDismiss,
              takeDown: current.page.inspection.canTakeDown,
            },
            currentState: current.page.inspection.currentState,
            destination: current.page.inspection.destination,
          }
        : {})}
      queueHref={queueHref}
      {...(props.onReturnQueue ? { onReturnQueue: returnToQueue } : {})}
      isCurrent={currentPage.isCurrent}
      register={currentPage.register}
      onAction={async (command) => {
        if (!currentPage.isCurrent()) return;
        if (currentPage.owner && !currentPage.owner.canCommand()) return { ok: false, state: 'forbidden' };
        return (props.onAction ?? nativeReportAction)(command);
      }}
      {...(props.onRefresh ? { onRefresh: props.onRefresh } : {})}
    />
  );
}

export function WorkbenchCaseDetail({
  report,
  target,
  revision,
  reportedRevisionState,
  actionAdvice,
  currentState,
  destination = null,
  queueHref,
  onReturnQueue,
  isCurrent,
  register,
  onAction,
  onRefresh,
}: {
  report: Report;
  target: Parameters<typeof ReportReviewCard>[0]['target'];
  revision: ReportTargetValue | null;
  reportedRevisionState?: Parameters<typeof ReportReviewCard>[0]['reportedRevisionState'];
  actionAdvice?: Readonly<{ dismiss: boolean; takeDown: boolean }>;
  currentState?: 'available' | 'taken-down' | 'erased' | 'withheld' | 'unavailable';
  destination?: Readonly<{ boardId: string; threadId?: string; realmId?: string }> | null;
  queueHref: string;
  onReturnQueue?: (source?: HTMLElement) => void;
  isCurrent: () => boolean;
  register: (controller: ReportsBulkAction) => () => void;
  onAction: ReportQueueAction;
  onRefresh?: () => Promise<void>;
}) {
  const [controller] = useState(() => createReportsBulkAction([report], isCurrent));
  const [takenDown, setTakenDown] = useState(false);
  useLayoutEffect(() => {
    controller.attach();
    const release = register(controller);
    return () => {
      controller.detach();
      release();
    };
  }, [controller, register]);
  useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  return (
    <AuthoringDepartureBoundary sessionBound={false} navigationContext={reportReviewNavigationContext}>
      <main className="mx-auto w-full max-w-5xl space-y-5 px-4 py-6 sm:px-8 sm:py-10">
        <WorkbenchCaseReturnLink href={queueHref} onReturnQueue={onReturnQueue}>
          {m.moderation_workbench_history_return()}
        </WorkbenchCaseReturnLink>
        <h1 className="text-2xl font-semibold">{m.moderation_queue_submission()}</h1>
        {currentState && currentState !== 'available' ? (
          <p role="status" className="text-sm text-muted-foreground">
            {currentState === 'taken-down'
              ? m.moderation_target_taken_down()
              : currentState === 'erased'
                ? m.moderation_target_deleted()
                : currentState === 'withheld'
                  ? m.moderation_target_withheld()
                  : m.moderation_target_unavailable()}
          </p>
        ) : null}
        {destination ? (
          <nav aria-label={m.moderation_current_destination()} className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
            <a
              className="min-h-11 break-all underline underline-offset-4"
              href={localizeHref(`/boards/${encodeURIComponent(destination.boardId)}`)}
            >
              {m.moderation_current_board({ id: destination.boardId })}
            </a>
            {destination.threadId ? (
              <a
                className="min-h-11 break-all underline underline-offset-4"
                href={localizeHref(`/threads/${encodeURIComponent(destination.threadId)}`)}
              >
                {m.moderation_current_thread({ id: destination.threadId })}
              </a>
            ) : null}
          </nav>
        ) : null}
        <ReportReviewCard
          report={report}
          target={target}
          revision={revision}
          takenDown={takenDown}
          onTakenDown={() => setTakenDown(true)}
          onAction={onAction}
          intentOwner={controller}
          bulkBlocked={controller.individualBlocked(report.id)}
          {...(reportedRevisionState !== undefined ? { reportedRevisionState } : {})}
          {...(actionAdvice ? { actionAdvice } : {})}
          {...(onRefresh ? { onRefresh } : {})}
        />
      </main>
    </AuthoringDepartureBoundary>
  );
}

export function WorkbenchCaseStatus({
  state,
  queueHref,
  onRetry,
  onRestart,
  onReturnQueue,
}: {
  state: 'loading' | 'denied' | 'stale' | 'error' | 'unavailable' | 'empty';
  queueHref: string;
  onRetry?: () => void;
  onRestart?: () => void;
  onReturnQueue?: (source?: HTMLElement) => void;
}) {
  const message =
    state === 'loading'
      ? m.moderation_queue_loading()
      : state === 'denied'
        ? m.moderation_queue_read_denied()
        : state === 'stale'
          ? m.moderation_queue_stale()
          : state === 'empty'
            ? m.moderation_reports_empty()
            : state === 'error'
              ? m.moderation_queue_error()
              : m.moderation_target_unavailable();
  return (
    <main className="mx-auto w-full max-w-3xl space-y-5 px-4 py-6 sm:px-8 sm:py-10">
      <WorkbenchCaseReturnLink href={queueHref} onReturnQueue={onReturnQueue}>
        {m.moderation_workbench_history_return()}
      </WorkbenchCaseReturnLink>
      <h1 className="text-2xl font-semibold">{m.moderation_queue_submission()}</h1>
      <ContentItemFrame
        as="div"
        role={state === 'loading' || state === 'empty' ? 'status' : 'alert'}
        className="space-y-3 p-4 sm:p-6"
      >
        <ContentItemHeading level={2} className="text-base font-semibold">
          {message}
        </ContentItemHeading>
        {state === 'stale' && onRestart ? (
          <Button className="min-h-11" variant="outline" onClick={onRestart}>
            {m.moderation_queue_restart()}
          </Button>
        ) : state === 'error' && onRetry ? (
          <Button className="min-h-11" variant="outline" onClick={onRetry}>
            {m.moderation_queue_retry()}
          </Button>
        ) : null}
      </ContentItemFrame>
    </main>
  );
}

function WorkbenchCaseReturnLink({
  href,
  onReturnQueue,
  children,
}: {
  href: string;
  onReturnQueue?: (source?: HTMLElement) => void;
  children: ReactNode;
}) {
  const departure = useAuthoringDeparture(
    false,
    false,
    `workbench-case-return:${href}`,
    undefined,
    undefined,
    undefined,
    reportReviewDepartureMessages(),
    reportReviewNavigationContext,
  );
  return (
    <a
      className="inline-flex min-h-11 items-center underline underline-offset-4"
      href={href}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        if (!onReturnQueue || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
          return;
        event.preventDefault();
        const source = event.currentTarget;
        departure.requestNavigation(() => onReturnQueue(source));
      }}
    >
      {children}
    </a>
  );
}
