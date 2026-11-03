import { QueryClientContext } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { useContext, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { m } from '../../paraglide/messages.js';
import { localizeHref } from '../../paraglide/runtime.js';
import { csrfHeaders } from '../../threads/composer';
import { AuthoringDepartureBoundary } from '../../threads/authoring-departure';
import { actionOnReport } from '../actions';
import { createReportsBulkAction, type ReportsBulkAction } from '../reports-bulk-action';
import type { PrivateReportPage, Report, ReportReadInput, ReportTargetValue } from '../reports-read';
import { reportPageIsCurrent, reportReadKey } from '../reports-read';
import type { ReportQueueAction } from '../reports-view-action';
import { ReportReviewCard } from '../reports-view-card';
import { createPrivateReaderLifetime } from '../private-reader-lifetime';
import type { ReportNavigation } from '../reports-page';
import { reportReviewNavigationContext } from '../reports-bulk-controls';
import { workbenchCaseFromPage, workbenchCaseQueueHref, type WorkbenchCaseSearch } from './read-model';

const nativeReportAction: ReportQueueAction = (data) => actionOnReport({ data, headers: csrfHeaders() });

export type WorkbenchCasePageProps = {
  page: PrivateReportPage;
  reportId: string;
  input: ReportReadInput;
  search?: WorkbenchCaseSearch;
  navigation?: ReportNavigation;
  active?: boolean;
  onAction?: ReportQueueAction;
  onRefresh?: () => Promise<void>;
  onRetry?: () => void;
  onRestart?: () => void;
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
  useSyncExternalStore(
    current.subscribe,
    () => current.owner?.snapshot() ?? Number(current.observe()),
    () => 0,
  );

  const retired = current.observe();
  const queueHref = localizeHref(workbenchCaseQueueHref(props.search ?? props.input));
  if (retired || (typeof window !== 'undefined' && !browserClient) || (current.owner && !current.owner.available()))
    return <WorkbenchCaseStatus state="unavailable" queueHref={queueHref} />;

  const result = workbenchCaseFromPage(props.page, props.reportId);
  if (result.state !== 'ready')
    return (
      <WorkbenchCaseStatus
        state={result.state}
        queueHref={queueHref}
        {...(props.onRetry ? { onRetry: props.onRetry } : {})}
        {...(props.onRestart ? { onRestart: props.onRestart } : {})}
      />
    );

  const currentPage = current;
  return (
    <WorkbenchCaseDetail
      report={result.report}
      target={result.target}
      revision={result.revision}
      queueHref={queueHref}
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
  queueHref,
  isCurrent,
  register,
  onAction,
  onRefresh,
}: {
  report: Report;
  target: Parameters<typeof ReportReviewCard>[0]['target'];
  revision: ReportTargetValue | null;
  queueHref: string;
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
        <a className="inline-flex min-h-11 items-center underline underline-offset-4" href={queueHref}>
          {m.moderation_workbench_history_return()}
        </a>
        <h1 className="text-2xl font-semibold">{m.moderation_queue_submission()}</h1>
        <ReportReviewCard
          report={report}
          target={target}
          revision={revision}
          takenDown={takenDown}
          onTakenDown={() => setTakenDown(true)}
          onAction={onAction}
          intentOwner={controller}
          bulkBlocked={controller.individualBlocked(report.id)}
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
}: {
  state: 'loading' | 'denied' | 'stale' | 'error' | 'unavailable' | 'empty';
  queueHref: string;
  onRetry?: () => void;
  onRestart?: () => void;
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
      <a className="inline-flex min-h-11 items-center underline underline-offset-4" href={queueHref}>
        {m.moderation_workbench_history_return()}
      </a>
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
