import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@rezics/ui/shadcn/select';
import { useEffect, useId, type MouseEvent } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { localizeHref } from '../../paraglide/runtime.js';
import { PageHeading } from '../../shell/page-heading';
import type { ReportsBulkAction } from '../reports-bulk-action';
import type { ReportQueueAction } from '../reports-view-action';
import { WorkbenchAppeal } from '../workbench-appeal';
import { openWorkbenchHistory, returnFromWorkbenchHistory, WorkbenchHistory } from '../workbench-history';
import { WorkbenchReportSelect, WorkbenchSelection } from '../workbench-selection';
import { WorkbenchTriageSummary, WorkbenchTriageDetails, workbenchTriageIdentity } from '../workbench-triage';
import { ModerationScope, moderationControl } from '../presentation';
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
import { ManualModerationScope } from './manual-scope';
import { workbenchQueueScope, type WorkbenchCase, type WorkbenchRead } from './read';
import { useAuthoringDeparture } from '../../threads/authoring-departure';
import { reportReviewDepartureMessages, reportReviewNavigationContext } from '../reports-bulk-controls';
import type { WorkbenchWindowMove, WorkbenchWindowRetry, WorkbenchWindowView } from './window-history';

const control = moderationControl;

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
  historyWindow?: WorkbenchWindowView;
  onHistoryMove?: (move: WorkbenchWindowMove | 'retry', source?: HTMLButtonElement, keyboard?: boolean) => void;
  onHistoryClose?: (source: HTMLButtonElement, keyboard: boolean) => void;
  queueWindow?: WorkbenchWindowView;
  retryWindow?: WorkbenchWindowRetry;
  onWindowMove?: (move: WorkbenchWindowMove, source?: HTMLButtonElement, keyboard?: boolean) => void;
  onRetryWindow?: (source?: HTMLButtonElement, keyboard?: boolean) => void;
  onOpenCase?: (item: WorkbenchCase, href: string, source?: HTMLAnchorElement, keyboard?: boolean) => void;
  onReturnAppeal?: (appealId: string, source: HTMLAnchorElement, event: MouseEvent<HTMLAnchorElement>) => void;
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
  onOpenCase?: (item: WorkbenchCase, href: string, source?: HTMLAnchorElement, keyboard?: boolean) => void;
  requestDeparture: (proceed: () => void) => void;
}) {
  const scope = workbenchQueueScope(search);
  if (!scope) return null;
  const href = localizeHref(workbenchCaseHref(item, search));
  return (
    <li
      id={item.kind === 'report' ? `workbench-case-${encodeURIComponent(item.id)}` : undefined}
      className="min-w-0 rounded-xl border bg-card p-4 sm:p-5"
    >
      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
        <div className="min-w-0 space-y-3">
          {selection && item.kind === 'report' ? (
            <WorkbenchReportSelect controller={selection} reportId={item.id} number={number} />
          ) : null}
          <WorkbenchTriageSummary item={item} />
          <div className="rounded-lg bg-muted/30 p-3">
            <WorkbenchTriageDetails item={item} identity={identity} />
          </div>
        </div>
        <a
          aria-label={m.moderation_workbench_open_case({ id: item.id })}
          className={`${control} inline-flex items-center justify-center rounded-md border border-primary px-4 text-center font-semibold text-primary underline-offset-4 hover:underline lg:self-start`}
          href={href}
          onClick={(event) => {
            if (isCurrent && !isCurrent()) event.preventDefault();
            else if (
              onOpenCase &&
              event.button === 0 &&
              !event.metaKey &&
              !event.ctrlKey &&
              !event.shiftKey &&
              !event.altKey
            ) {
              event.preventDefault();
              const source = event.currentTarget;
              const keyboard = event.detail === 0 && source.ownerDocument.activeElement === source;
              const open = () => onOpenCase(item, href, source, keyboard);
              requestDeparture(open);
            }
          }}
          {...(item.kind === 'appeal' ? { 'data-workbench-appeal-activator': encodeURIComponent(item.id) } : {})}
        >
          {m.moderation_case_open()}
        </a>
      </div>
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
  historyWindow,
  onHistoryMove,
  onHistoryClose,
  queueWindow,
  retryWindow,
  onWindowMove,
  onRetryWindow,
  onOpenCase,
  onReturnAppeal,
}: WorkbenchViewProps) {
  const filterId = useId();
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
  const leaveFor = (
    event: MouseEvent<HTMLButtonElement>,
    proceed: (source: HTMLButtonElement, keyboard: boolean) => void,
  ) => {
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
    if (page.state === 'ready' && search.historyReturn && (!isCurrent || isCurrent()))
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
      data-workbench-frame=""
      className="mx-auto w-full min-w-0 max-w-7xl space-y-6 text-foreground [overflow-wrap:anywhere]"
    >
      <header className="flex min-w-0 flex-col gap-3 border-b pb-5 sm:flex-row sm:items-start sm:justify-between">
        <PageHeading>{m.moderation_workbench_heading()}</PageHeading>
        <div className="min-w-0 space-y-2 sm:max-w-md sm:text-right">
          {queueScope ? (
            <ModerationScope
              kind={queueScope.kind}
              {...(boardId ? { id: boardId, label: page.boards.find((board) => board.id === boardId)?.title } : {})}
              admitted={page.state === 'ready' && isCurrent?.() !== false}
            />
          ) : (
            <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">{m.moderation_workbench_intro()}</p>
          )}
        </div>
      </header>
      {status && !search.history ? (
        <p
          role={page.state === 'unavailable' || page.state === 'stale' ? 'alert' : 'status'}
          className="rounded-lg border border-border bg-muted/30 p-4 text-muted-foreground"
        >
          {status}
        </p>
      ) : null}
      {scope.kind === 'catalogue' && search.queue === 'appeals' ? (
        <p role="status" className="text-muted-foreground">
          {m.moderation_workbench_catalogue_appeals()}
        </p>
      ) : null}
      {((page.state === 'unavailable' && !search.history && onRetry && !(isWindowQueue && queueWindow?.retry)) ||
        (page.state === 'stale' && !search.history && !(isWindowQueue && onWindowMove))) ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
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
        </div>
      ) : null}
      {scope.kind !== 'none' && !(page.state === 'ready' || search.history) ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
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
        </div>
      ) : null}
      {page.state === 'ready' && (scope.kind === 'none' || scope.kind === 'realm') ? (
        <section
          aria-label={m.moderation_directory_heading()}
          className="grid min-w-0 gap-5 lg:grid-cols-[minmax(16rem,0.8fr)_minmax(0,1.8fr)] lg:items-start"
        >
          <div className="min-w-0 rounded-xl border bg-card p-4 sm:p-5">
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
            <ManualModerationScope search={search} onSearch={onSearch} {...(isCurrent ? { isCurrent } : {})} />
          </div>
          <div className="min-w-0 rounded-xl border bg-card p-4 sm:p-5">
            <ModerationDirectory
              page={page.directory}
              search={search}
              onSearch={onSearch}
              {...(onRetry ? { onRetry } : {})}
              {...(isCurrent ? { isCurrent } : {})}
            />
          </div>
        </section>
      ) : null}
      {(page.state === 'ready' || search.history) && queueScope ? (
        <section
          className="grid min-w-0 gap-6 lg:grid-cols-[15rem_minmax(0,1fr)] lg:items-start lg:gap-8"
          aria-label={m.moderation_workbench_heading()}
        >
          <aside className="min-w-0 space-y-5 rounded-xl border bg-card p-4 sm:p-5 lg:sticky lg:top-4 lg:self-start">
            {scope.kind !== 'none' ? (
              <Button
                type="button"
                variant="outline"
                className={`${control} w-full justify-start`}
                onClick={() => {
                  if (!isCurrent || isCurrent()) onSearch(workbenchDirectorySearch(search));
                }}
              >
                {m.moderation_directory_return()}
              </Button>
            ) : null}
            <nav aria-label={m.moderation_tabs_label()} className="flex min-w-0 flex-col gap-1">
              {(['reports', 'appeals', 'resolved'] as const)
                .filter((queue) => scope.kind !== 'catalogue' || queue !== 'appeals')
                .map((queue) => (
                  <Button
                    key={queue}
                    type="button"
                    variant="ghost"
                    id={`workbench-queue-${queue}`}
                    aria-current={!search.history && search.queue === queue ? 'page' : undefined}
                    className={`${control} w-full justify-start text-left ${!search.history && search.queue === queue ? 'bg-muted font-semibold' : ''}`}
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
                  className={`${control} w-full justify-start text-left ${search.history ? 'bg-muted font-semibold' : ''}`}
                  onClick={() => onSearch(openWorkbenchHistory(search))}
                >
                  {m.moderation_workbench_history()}
                </Button>
              ) : null}
            </nav>
            {!search.history && !search.case && queueScope.kind === 'board' && search.queue !== 'appeals' ? (
              <fieldset className="grid min-w-0 gap-3 border-t pt-4">
                <legend className="sr-only">{m.moderation_filter_kind()}</legend>
                <Field className="min-w-0 space-y-1 text-sm">
                  <FieldLabel htmlFor={`${filterId}-kind`}>{m.moderation_filter_kind()}</FieldLabel>
                  <Select
                    items={[
                      { value: 'all', label: m.moderation_filter_all_kinds() },
                      { value: 'board', label: m.moderation_queue_board() },
                      { value: 'thread', label: m.moderation_queue_thread() },
                      { value: 'post', label: m.moderation_queue_post() },
                    ]}
                    value={search.targetKind}
                    onValueChange={(value) =>
                      onSearch(
                        workbenchSearch({
                          ...workbenchWithoutContinuation(search),
                          targetKind: value!,
                        }),
                      )
                    }
                  >
                    <SelectTrigger id={`${filterId}-kind`} className="w-full min-w-0 max-w-full min-h-11 min-w-11">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="all">{m.moderation_filter_all_kinds()}</SelectItem>
                        <SelectItem value="board">{m.moderation_queue_board()}</SelectItem>
                        <SelectItem value="thread">{m.moderation_queue_thread()}</SelectItem>
                        <SelectItem value="post">{m.moderation_queue_post()}</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
                <Field className="min-w-0 space-y-1 text-sm">
                  <FieldLabel htmlFor={`${filterId}-order`}>{m.moderation_filter_order()}</FieldLabel>
                  <Select
                    items={[
                      { value: 'newest', label: m.moderation_filter_newest() },
                      { value: 'oldest', label: m.moderation_filter_oldest() },
                    ]}
                    value={search.order}
                    onValueChange={(value) =>
                      onSearch(workbenchSearch({ ...workbenchWithoutContinuation(search), order: value! }))
                    }
                  >
                    <SelectTrigger id={`${filterId}-order`} className="w-full min-w-0 max-w-full min-h-11 min-w-11">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="newest">{m.moderation_filter_newest()}</SelectItem>
                        <SelectItem value="oldest">{m.moderation_filter_oldest()}</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
              </fieldset>
            ) : null}
          </aside>
          <div className="min-w-0">
          <section className="min-w-0 max-w-4xl space-y-5" aria-label={m.moderation_workbench_heading()}>
          {!search.history ? (
            <h2
              tabIndex={isWindowQueue ? -1 : undefined}
              {...(isWindowQueue ? { 'data-workbench-current-queue': '' } : {})}
              className="text-xl font-semibold"
            >
              {search.queue === 'appeals'
                ? m.moderation_workbench_queue_appeals()
                : search.queue === 'resolved'
                  ? m.moderation_workbench_queue_resolved()
                  : m.moderation_workbench_queue_reports()}
            </h2>
          ) : null}
          {search.history && scope.kind === 'board' ? (
            <WorkbenchHistory
              page={page.history ?? { state: page.state, entries: [], next: null }}
              search={search}
              windows={historyWindow}
              onMove={onHistoryMove}
              onClose={onHistoryClose}
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
                {...(onReturnAppeal ? { onReturn: onReturnAppeal } : {})}
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
                <div className="mb-4 rounded-xl border bg-muted/20 p-4">
                <WorkbenchSelection
                  controller={selection}
                  boardId={boardId}
                  reports={page.reports ?? []}
                  onAction={onAction}
                  {...(onRefresh ? { onRefresh } : {})}
                />
                </div>
              ) : null}
              <ul key={identity} className="min-w-0 space-y-3">
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
          {isWindowQueue ? (
            <>
              <nav aria-label={m.moderation_workbench_heading()} className="flex flex-wrap gap-2 border-t pt-4">
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
              <p role="status" className="sr-only">
                {m.moderation_workbench_window_loaded()}
              </p>
            </>
          ) : null}
          {!search.history && !search.case && next && !isWindowQueue ? (
            <div className="border-t pt-4">
              <Button
                type="button"
                className={control}
                onClick={() => onSearch(workbenchSearch({ ...search, cursor: next }))}
              >
                {m.threads_next_page()}
              </Button>
            </div>
          ) : null}
          </section>
          </div>
        </section>
      ) : null}
      {isWindowQueue && page.state !== 'ready' && !search.history && queueWindow ? (
        <nav aria-label={m.moderation_workbench_heading()} className="flex flex-wrap gap-2 border-t pt-4">
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
