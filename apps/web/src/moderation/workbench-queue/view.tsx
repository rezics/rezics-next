import { useEffect, type MouseEvent } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { m } from '../../paraglide/messages.js';
import { localizeHref } from '../../paraglide/runtime.js';
import { PageHeading } from '../../shell/page-heading';
import type { ReportsBulkAction } from '../reports-bulk-action';
import type { ReportQueueAction } from '../reports-view-action';
import { WorkbenchAppeal } from '../workbench-appeal';
import { openWorkbenchHistory, returnFromWorkbenchHistory, WorkbenchHistory } from '../workbench-history';
import { WorkbenchReportSelect, WorkbenchSelection } from '../workbench-selection';
import { WorkbenchTriageCase, workbenchTriageIdentity } from '../workbench-triage';
import {
  workbenchDirectorySearch,
  workbenchCaseHref,
  workbenchQueueHref,
  workbenchScope,
  workbenchSearch,
  workbenchWithoutContinuation,
  type WorkbenchSearch,
} from './scope';
import { ModerationDirectory } from './directory-view';
import { workbenchQueueScope, type WorkbenchCase, type WorkbenchRead } from './read';
import { useAuthoringDeparture } from '../../threads/authoring-departure';
import { reportReviewDepartureMessages, reportReviewNavigationContext } from '../reports-bulk-controls';
import type { WorkbenchWindowMove, WorkbenchWindowRetry, WorkbenchWindowView } from './window-history';

const control =
  'inline-flex h-auto min-h-11 min-w-11 max-w-full items-center justify-center whitespace-normal break-words px-3 py-2 focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

export type WorkbenchViewProps = {
  page: Pick<WorkbenchRead, 'state' | 'realms' | 'realmsNext' | 'boards' | 'boardsNext' | 'cases' | 'next' | 'search'> &
    Partial<
      Pick<
        WorkbenchRead,
        | 'readKey'
        | 'generation'
        | 'reports'
        | 'appeals'
        | 'selectedTarget'
        | 'selectedAppeal'
        | 'nativeSession'
        | 'directory'
        | 'history'
      >
    >;
  onSearch: (search: WorkbenchSearch) => void;
  onRetry?: (event?: MouseEvent<HTMLButtonElement>) => void;
  onRestart?: () => void;
  selection?: ReportsBulkAction;
  onAction?: ReportQueueAction;
  onRefresh?: () => Promise<void>;
  isCurrent?: () => boolean;
  onUnresolvedAppealChange?: (unresolved: boolean) => void;
  refreshBlocked?: boolean;
  queueWindow?: WorkbenchWindowView;
  retryWindow?: WorkbenchWindowRetry;
  onWindowMove?: (move: WorkbenchWindowMove, source?: HTMLButtonElement, keyboard?: boolean) => void;
  onRetryWindow?: (source?: HTMLButtonElement, keyboard?: boolean) => void;
  onOpenCase?: (item: WorkbenchCase, href: string) => void;
};

function CaseRow({
  item,
  search,
  identity,
  selection,
  number,
  isCurrent,
  onOpenCase,
  requestDeparture,
}: {
  item: WorkbenchCase;
  search: WorkbenchSearch;
  identity: string;
  selection?: ReportsBulkAction;
  number: number;
  isCurrent?: () => boolean;
  onOpenCase?: (item: WorkbenchCase, href: string) => void;
  requestDeparture: (proceed: () => void) => void;
}) {
  const scope = workbenchQueueScope(search);
  if (!scope) return null;
  const href = localizeHref(workbenchCaseHref(item, search));
  return (
    <li id={item.kind === 'report' ? `workbench-case-${encodeURIComponent(item.id)}` : undefined} className="min-w-0 border-b py-3">
      {selection && item.kind === 'report' ? (
        <WorkbenchReportSelect controller={selection} reportId={item.id} number={number} />
      ) : null}
      <a
        className={`${control} justify-start text-left font-medium underline-offset-4 hover:underline`}
        href={href}
        onClick={(event) => {
          if (isCurrent && !isCurrent()) event.preventDefault();
          else if (
            item.kind === 'report' &&
            onOpenCase &&
            event.button === 0 &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.shiftKey &&
            !event.altKey
          ) {
            event.preventDefault();
            const open = () => onOpenCase(item, href);
            requestDeparture(open);
          }
        }}
      >
        {m.moderation_workbench_open_case({ id: item.id })}
      </a>
      <WorkbenchTriageCase item={item} identity={identity} />
    </li>
  );
}

export function WorkbenchView({
  page,
  onSearch,
  onRetry,
  onRestart,
  selection,
  onAction,
  onRefresh,
  isCurrent,
  onUnresolvedAppealChange,
  refreshBlocked,
  queueWindow,
  retryWindow,
  onWindowMove,
  onRetryWindow,
  onOpenCase,
}: WorkbenchViewProps) {
  const departure = useAuthoringDeparture(
    false,
    false,
    'workbench-queue-navigation',
    undefined,
    undefined,
    undefined,
    reportReviewDepartureMessages(),
    reportReviewNavigationContext,
  );
  const search = page.search;
  const identity = workbenchTriageIdentity(page);
  const scope = workbenchScope(search);
  const queueScope = workbenchQueueScope(search);
  const boardId = scope.kind === 'board' ? scope.boardId : undefined;
  const next = page.next;
  const isWindowQueue =
    !search.history &&
    !search.case &&
    queueScope?.kind === 'board' &&
    (search.queue === 'reports' || search.queue === 'resolved');
  const leaveFor = (event: MouseEvent<HTMLButtonElement>, proceed: (source: HTMLButtonElement, keyboard: boolean) => void) => {
    const source = event.currentTarget;
    const keyboard = event.detail === 0 && source.ownerDocument.activeElement === source;
    departure.requestNavigation(() => proceed(source, keyboard));
  };
  const windowControl = (move: WorkbenchWindowMove, label: string, enabled: boolean) => (
    <Button
      key={move}
      type="button"
      variant="outline"
      className={control}
      disabled={!enabled}
      onClick={(event) => {
        leaveFor(event, (source, keyboard) => onWindowMove?.(move, source, keyboard));
      }}
    >
      {label}
    </Button>
  );
  useEffect(() => {
    if (search.historyReturn && (!isCurrent || isCurrent()))
      document.getElementById(`workbench-queue-${search.queue}`)?.focus();
  }, [search.historyReturn, search.queue, isCurrent]);
  const status =
    page.state === 'denied'
      ? m.moderation_workbench_denied()
      : page.state === 'unavailable'
        ? m.moderation_workbench_unavailable()
        : page.state === 'stale'
          ? m.moderation_workbench_stale()
          : null;
  return (
    <article
      tabIndex={-1}
      className="mx-auto w-full min-w-0 max-w-4xl space-y-6 text-foreground [overflow-wrap:anywhere]"
    >
      <header className="space-y-3">
        <PageHeading>{m.moderation_workbench_heading()}</PageHeading>
        <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">{m.moderation_workbench_intro()}</p>
        <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
          {m.moderation_workbench_membership_hint()}
        </p>
      </header>
      {status && !search.history ? (
        <p
          role={page.state === 'unavailable' || page.state === 'stale' ? 'alert' : 'status'}
          className="text-muted-foreground"
        >
          {status}
        </p>
      ) : null}
      {scope.kind === 'catalogue' && search.queue === 'appeals' ? (
        <p role="status" className="text-muted-foreground">
          {m.moderation_workbench_catalogue_appeals()}
        </p>
      ) : null}
      {page.state === 'unavailable' && !search.history && onRetry && !(isWindowQueue && queueWindow?.retry) ? (
        <Button data-workbench-retry type="button" className={control} onClick={onRetry}>
          {m.moderation_queue_retry()}
        </Button>
      ) : null}
      {page.state === 'stale' && !search.history && !(isWindowQueue && onWindowMove) ? (
        <Button
          type="button"
          className={control}
          onClick={(event) => {
            if (isWindowQueue && onWindowMove)
              leaveFor(event, (source, keyboard) => onWindowMove('first', source, keyboard));
            else onSearch(workbenchWithoutContinuation(search));
          }}
        >
          {m.moderation_queue_restart()}
        </Button>
      ) : null}
      {isWindowQueue ? (
        <h2 tabIndex={-1} data-workbench-current-queue className="sr-only">
          {search.queue === 'resolved'
            ? m.moderation_workbench_queue_resolved()
            : m.moderation_workbench_queue_reports()}
        </h2>
      ) : null}
      {scope.kind !== 'none' ? (
        <Button
          type="button"
          variant="outline"
          className={control}
          onClick={() => {
            if (!isCurrent || isCurrent()) onSearch(workbenchDirectorySearch(search));
          }}
        >
          {m.moderation_directory_return()}
        </Button>
      ) : null}
      {queueScope && search.directory ? (
        <p className="text-sm text-muted-foreground">{m.moderation_directory_return_hint()}</p>
      ) : null}
      {page.state === 'ready' && (scope.kind === 'none' || scope.kind === 'realm') ? (
        <ModerationDirectory
          page={page.directory}
          search={search}
          onSearch={onSearch}
          {...(onRetry ? { onRetry } : {})}
          {...(isCurrent ? { isCurrent } : {})}
        />
      ) : null}
      {(page.state === 'ready' || search.history) && queueScope ? (
        <section className="space-y-4" aria-label={m.moderation_workbench_heading()}>
          {isWindowQueue ? (
            <>
              <nav aria-label={m.moderation_workbench_heading()} className="flex flex-wrap gap-2">
                {windowControl('previous', m.moderation_workbench_previous(), Boolean(queueWindow?.previous))}
                {next ? windowControl('next', m.threads_next_page(), true) : null}
                <Button
                  type="button"
                  variant="outline"
                  className={control}
                  disabled={!queueWindow?.refresh}
                  onClick={(event) => {
                    leaveFor(event, (source, keyboard) => onWindowMove?.('refresh', source, keyboard));
                  }}
                >
                  {m.moderation_workbench_refresh_window()}
                </Button>
                {windowControl('first', m.moderation_workbench_first(), Boolean(queueWindow?.first))}
                {queueWindow?.retry && onRetryWindow ? (
                  <Button
                    type="button"
                    variant="outline"
                    className={control}
                    data-workbench-retry
                    onClick={(event) => {
                      const source = event.currentTarget;
                      const keyboard = event.detail === 0 && source.ownerDocument.activeElement === source;
                      departure.requestNavigation(() => onRetryWindow(source, keyboard));
                    }}
                  >
                    {queueWindow.retry === 'previous'
                      ? m.moderation_workbench_retry_previous()
                      : queueWindow.retry === 'next'
                        ? m.moderation_workbench_retry_next()
                        : queueWindow.retry === 'refresh'
                          ? m.moderation_workbench_retry_refresh()
                          : queueWindow.retry === 'first'
                            ? m.moderation_workbench_retry_first()
                            : m.moderation_workbench_retry_current()}
                  </Button>
                ) : null}
              </nav>
              <p role="status" className="sr-only">{m.moderation_workbench_window_loaded()}</p>
            </>
          ) : null}
          <nav aria-label={m.moderation_tabs_label()} className="flex min-w-0 flex-wrap gap-2 border-b pb-2">
            {(['reports', 'appeals', 'resolved'] as const)
              .filter((queue) => scope.kind !== 'catalogue' || queue !== 'appeals')
              .map((queue) => (
                <Button
                  key={queue}
                  type="button"
                  variant="ghost"
                  id={`workbench-queue-${queue}`}
                  aria-current={!search.history && search.queue === queue ? 'page' : undefined}
                  className={`${control} rounded-none border-b-2 ${search.queue === queue ? 'border-primary font-semibold' : 'border-transparent'}`}
                  onClick={() =>
                    onSearch(
                      workbenchSearch({
                        ...workbenchWithoutContinuation(search),
                        queue,
                        status: queue === 'resolved' ? 'resolved' : 'pending',
                      }),
                    )
                  }
                >
                  {queue === 'appeals'
                    ? m.moderation_workbench_queue_appeals()
                    : queue === 'resolved'
                      ? m.moderation_workbench_queue_resolved()
                      : m.moderation_workbench_queue_reports()}
                </Button>
              ))}
            {scope.kind === 'board' ? (
              <Button
                type="button"
                variant="ghost"
                aria-current={search.history ? 'page' : undefined}
                className={`${control} rounded-none border-b-2 ${search.history ? 'border-primary font-semibold' : 'border-transparent'}`}
                onClick={() => onSearch(openWorkbenchHistory(search))}
              >
                {m.moderation_workbench_history()}
              </Button>
            ) : null}
          </nav>
          {!search.history && queueScope.kind === 'board' && search.queue !== 'appeals' ? (
            <fieldset className="flex min-w-0 flex-wrap items-end gap-3">
              <legend className="sr-only">{m.moderation_filter_kind()}</legend>
              <label className="min-w-0 flex-1 basis-48 space-y-1 text-sm">
                <span className="block">{m.moderation_filter_kind()}</span>
                <NativeSelect
                  className="w-full min-w-0 max-w-full [&_select]:min-h-11 [&_select]:min-w-11"
                  value={search.targetKind}
                  onChange={(event) =>
                    onSearch(
                      workbenchSearch({
                        ...workbenchWithoutContinuation(search),
                        targetKind: event.target.value,
                      }),
                    )
                  }
                >
                  <NativeSelectOption value="all">{m.moderation_filter_all_kinds()}</NativeSelectOption>
                  <NativeSelectOption value="board">{m.moderation_queue_board()}</NativeSelectOption>
                  <NativeSelectOption value="thread">{m.moderation_queue_thread()}</NativeSelectOption>
                  <NativeSelectOption value="post">{m.moderation_queue_post()}</NativeSelectOption>
                </NativeSelect>
              </label>
              <label className="min-w-0 flex-1 basis-48 space-y-1 text-sm">
                <span className="block">{m.moderation_filter_order()}</span>
                <NativeSelect
                  className="w-full min-w-0 max-w-full [&_select]:min-h-11 [&_select]:min-w-11"
                  value={search.order}
                  onChange={(event) =>
                    onSearch(workbenchSearch({ ...workbenchWithoutContinuation(search), order: event.target.value }))
                  }
                >
                  <NativeSelectOption value="newest">{m.moderation_filter_newest()}</NativeSelectOption>
                  <NativeSelectOption value="oldest">{m.moderation_filter_oldest()}</NativeSelectOption>
                </NativeSelect>
              </label>
            </fieldset>
          ) : null}
          {search.history && scope.kind === 'board' ? (
            <WorkbenchHistory
              page={page.history ?? { state: page.state, entries: [], next: null }}
              search={search}
              onSearch={onSearch}
              onReturn={() => onSearch(returnFromWorkbenchHistory(search))}
              {...(onRetry ? { onRetry } : {})}
            />
          ) : search.queue === 'appeals' && search.case && queueScope?.kind === 'board' ? (
            <div className="space-y-4">
              <WorkbenchAppeal
                appealId={search.case}
                {...(page.nativeSession ? { nativeSession: page.nativeSession } : {})}
                page={{
                  state: page.state,
                  appeals: page.appeals ?? [],
                  ...(page.selectedAppeal ? { selectedAppeal: page.selectedAppeal } : {}),
                }}
                queueHref={localizeHref(workbenchQueueHref(workbenchSearch({ ...search, case: '' })))}
                {...(isCurrent ? { isCurrent } : {})}
                {...(onRetry ? { onRetry } : {})}
                {...(onRestart ? { onRestart } : {})}
                {...(onUnresolvedAppealChange ? { onUnresolvedChange: onUnresolvedAppealChange } : {})}
              />
              {onRefresh ? (
                <Button
                  className={control}
                  variant="outline"
                  disabled={refreshBlocked}
                  onClick={() => void onRefresh()}
                >
                  {m.moderation_queue_refresh()}
                </Button>
              ) : null}
              {refreshBlocked ? <p role="status">{m.moderation_appeals_refresh_blocked()}</p> : null}
            </div>
          ) : search.queue === 'appeals' && scope.kind === 'catalogue' ? null : page.cases.length === 0 ? (
            <p role="status" className="text-muted-foreground">
              {next ? m.moderation_workbench_empty_next() : m.moderation_workbench_empty()}
            </p>
          ) : (
            <>
              {selection && boardId && onAction ? (
                <WorkbenchSelection
                  controller={selection}
                  boardId={boardId}
                  reports={page.reports ?? []}
                  onAction={onAction}
                  {...(onRefresh ? { onRefresh } : {})}
                />
              ) : null}
              <ul key={identity} className="min-w-0">
                {page.cases.map((item, index) => (
                  <CaseRow
                    key={`${item.kind}:${item.id}`}
                    item={item}
                    search={search}
                    identity={identity}
                    number={index + 1}
                    {...(selection ? { selection } : {})}
                    {...(isCurrent ? { isCurrent } : {})}
                    {...(onOpenCase ? { onOpenCase } : {})}
                    requestDeparture={departure.requestNavigation}
                  />
                ))}
              </ul>
            </>
          )}
          {!search.history && !search.case && next && !isWindowQueue ? (
            <Button
              type="button"
              className={control}
              onClick={() => onSearch(workbenchSearch({ ...search, cursor: next }))}
            >
              {m.threads_next_page()}
            </Button>
          ) : null}
        </section>
      ) : null}
      {isWindowQueue && page.state !== 'ready' && !search.history && queueWindow ? (
        <nav aria-label={m.moderation_workbench_heading()} className="flex flex-wrap gap-2">
          {windowControl('previous', m.moderation_workbench_previous(), Boolean(queueWindow.previous))}
          <Button
            type="button"
            variant="outline"
            className={control}
            disabled={!queueWindow.refresh}
            onClick={(event) => leaveFor(event, (source, keyboard) => onWindowMove?.('refresh', source, keyboard))}
          >
            {m.moderation_workbench_refresh_window()}
          </Button>
          {windowControl('first', m.moderation_workbench_first(), Boolean(queueWindow.first))}
          {queueWindow.retry && onRetryWindow ? (
            <Button
              type="button"
              variant="outline"
              className={control}
              data-workbench-retry
              onClick={(event) => {
                const source = event.currentTarget;
                const keyboard = event.detail === 0 && source.ownerDocument.activeElement === source;
                departure.requestNavigation(() => onRetryWindow(source, keyboard));
              }}
            >
              {queueWindow.retry === 'previous'
                ? m.moderation_workbench_retry_previous()
                : queueWindow.retry === 'next'
                  ? m.moderation_workbench_retry_next()
                  : queueWindow.retry === 'refresh'
                    ? m.moderation_workbench_retry_refresh()
                    : queueWindow.retry === 'first'
                      ? m.moderation_workbench_retry_first()
                      : m.moderation_workbench_retry_current()}
            </Button>
          ) : null}
        </nav>
      ) : null}
    </article>
  );
}

export function WorkbenchPreparing() {
  return (
    <article className="mx-auto w-full min-w-0 max-w-4xl space-y-6">
      <PageHeading>{m.moderation_workbench_heading()}</PageHeading>
      <p role="status" className="text-muted-foreground">
        {m.moderation_workbench_preparing()}
      </p>
    </article>
  );
}
