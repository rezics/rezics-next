import { useEffect } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { m } from '../../paraglide/messages.js';
import { localizeHref } from '../../paraglide/runtime.js';
import { PageHeading } from '../../shell/page-heading';
import type { ReportsBulkAction } from '../reports-bulk-action';
import type { ReportQueueAction } from '../reports-view-action';
import { WorkbenchAppeal } from '../workbench-appeal';
import { openWorkbenchHistory, returnFromWorkbenchHistory, WorkbenchHistoryUnavailable } from '../workbench-history';
import { WorkbenchReportSelect, WorkbenchSelection } from '../workbench-selection';
import { WorkbenchTriageCase, workbenchTriageIdentity } from '../workbench-triage';
import {
  workbenchCaseHref,
  workbenchQueueHref,
  workbenchScope,
  workbenchSearch,
  workbenchWithoutContinuation,
  type WorkbenchSearch,
} from './scope';
import { workbenchQueueScope, type WorkbenchCase, type WorkbenchDirectoryItem, type WorkbenchRead } from './read';

const control =
  'inline-flex h-auto min-h-11 min-w-11 max-w-full items-center justify-center whitespace-normal break-words px-3 py-2 focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

export type WorkbenchViewProps = {
  page: Pick<WorkbenchRead, 'state' | 'realms' | 'realmsNext' | 'boards' | 'boardsNext' | 'cases' | 'next' | 'search'> &
    Partial<Pick<WorkbenchRead, 'readKey' | 'generation' | 'reports' | 'appeals' | 'selectedTarget'>>;
  onSearch: (search: WorkbenchSearch) => void;
  onRetry?: () => void;
  onRestart?: () => void;
  selection?: ReportsBulkAction;
  onAction?: ReportQueueAction;
  onRefresh?: () => Promise<void>;
  isCurrent?: () => boolean;
};

function labelOf(item: WorkbenchDirectoryItem): string {
  return item.title?.trim() || m.moderation_target_unavailable();
}

function CaseRow({
  item,
  search,
  identity,
  selection,
  number,
}: {
  item: WorkbenchCase;
  search: WorkbenchSearch;
  identity: string;
  selection?: ReportsBulkAction;
  number: number;
}) {
  const scope = workbenchQueueScope(search);
  if (!scope) return null;
  const href = localizeHref(workbenchCaseHref(item, search));
  return (
    <li className="min-w-0 border-b py-3">
      {selection && item.kind === 'report' ? (
        <WorkbenchReportSelect controller={selection} reportId={item.id} number={number} />
      ) : null}
      <a className={`${control} justify-start text-left font-medium underline-offset-4 hover:underline`} href={href}>
        {m.moderation_workbench_open_case({ id: item.id })}
      </a>
      <WorkbenchTriageCase item={item} identity={identity} />
    </li>
  );
}

function Directory({
  label,
  items,
  next,
  onSelect,
  onNext,
  empty,
}: {
  label: string;
  items: WorkbenchDirectoryItem[];
  next: string | null;
  onSelect: (id: string) => void;
  onNext?: () => void;
  empty: string;
}) {
  return (
    <section className="space-y-3" aria-label={label}>
      <h2 className="text-xl font-semibold">{label}</h2>
      {items.length === 0 ? <p className="text-muted-foreground">{empty}</p> : null}
      {items.length > 0 ? (
        <ul className="min-w-0 divide-y">
          {items.map((item) => (
            <li key={item.id}>
              <Button
                type="button"
                variant="ghost"
                className={`${control} w-full justify-start text-left`}
                onClick={() => onSelect(item.id)}
              >
                {labelOf(item)}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {next && onNext ? (
        <Button type="button" variant="outline" className={control} onClick={onNext}>
          {m.threads_next_page()}
        </Button>
      ) : null}
    </section>
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
}: WorkbenchViewProps) {
  const search = page.search;
  const identity = workbenchTriageIdentity(page);
  const scope = workbenchScope(search);
  const queueScope = workbenchQueueScope(search);
  const boardId = scope.kind === 'board' ? scope.boardId : undefined;
  const next = page.next;
  const realmsNext = page.realmsNext;
  const boardsNext = page.boardsNext;
  useEffect(() => {
    if (search.historyReturn) document.getElementById(`workbench-queue-${search.queue}`)?.focus();
  }, [search.historyReturn, search.queue]);
  const status =
    page.state === 'denied'
      ? m.moderation_workbench_denied()
      : page.state === 'unavailable'
        ? m.moderation_workbench_unavailable()
        : page.state === 'stale'
          ? m.moderation_workbench_stale()
          : null;
  return (
    <article className="mx-auto w-full min-w-0 max-w-4xl space-y-6 text-foreground [overflow-wrap:anywhere]">
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
      {page.state === 'unavailable' && onRetry ? (
        <Button type="button" className={control} onClick={onRetry}>
          {m.moderation_queue_retry()}
        </Button>
      ) : null}
      {page.state === 'stale' ? (
        <Button type="button" className={control} onClick={() => onSearch(workbenchWithoutContinuation(search))}>
          {m.moderation_queue_restart()}
        </Button>
      ) : null}
      {page.state === 'ready' || page.state === 'denied' || search.history || search.historyReturn ? (
        <div className="flex min-w-0 flex-wrap gap-2">
          <Button
            type="button"
            variant={scope.kind === 'catalogue' ? 'default' : 'outline'}
            className={control}
            aria-pressed={scope.kind === 'catalogue'}
            onClick={() =>
              onSearch(
                workbenchSearch({
                  queue: search.queue === 'appeals' ? 'reports' : search.queue,
                  status: search.queue === 'resolved' ? 'resolved' : 'pending',
                  targetKind: 'all',
                  order: search.order,
                  scope: 'catalogue',
                }),
              )
            }
          >
            {m.moderation_workbench_catalogue()}
          </Button>
          {scope.kind !== 'none' ? (
            <Button
              type="button"
              variant="outline"
              className={control}
              onClick={() =>
                onSearch(workbenchSearch({ queue: 'reports', status: 'pending', targetKind: 'all', order: 'newest' }))
              }
            >
              {m.public_account_realms()}
            </Button>
          ) : null}
        </div>
      ) : null}
      {page.state === 'ready' && scope.kind === 'none' ? (
        <Directory
          label={m.public_account_realms()}
          items={page.realms}
          next={page.realmsNext}
          empty={m.moderation_workbench_realms_empty()}
          onSelect={(realm) =>
            onSearch(
              workbenchSearch({ queue: 'reports', status: 'pending', targetKind: 'all', order: 'newest', realm }),
            )
          }
          {...(realmsNext ? { onNext: () => onSearch(workbenchSearch({ ...search, realmsCursor: realmsNext })) } : {})}
        />
      ) : null}
      {page.state === 'ready' && scope.kind === 'realm' ? (
        <Directory
          label={m.realm_boards_heading()}
          items={page.boards}
          next={page.boardsNext}
          empty={m.moderation_workbench_boards_empty()}
          onSelect={(board) =>
            onSearch(
              workbenchSearch({
                queue: 'reports',
                status: 'pending',
                targetKind: 'all',
                order: search.order,
                ...(search.realm ? { realm: search.realm } : {}),
                board,
              }),
            )
          }
          {...(boardsNext ? { onNext: () => onSearch(workbenchSearch({ ...search, boardsCursor: boardsNext })) } : {})}
        />
      ) : null}
      {page.state === 'ready' && scope.kind === 'none' ? (
        <p className="text-sm text-muted-foreground">{m.moderation_workbench_select_scope()}</p>
      ) : null}
      {page.state === 'ready' && queueScope ? (
        <section className="space-y-4" aria-label={m.moderation_workbench_heading()}>
          <nav aria-label={m.moderation_tabs_label()} className="flex min-w-0 flex-wrap gap-2 border-b pb-2">
            {(['reports', 'appeals', 'resolved'] as const).map((queue) => (
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
          {scope.kind === 'catalogue' && search.queue === 'appeals' ? (
            <p role="status" className="text-muted-foreground">
              {m.moderation_workbench_catalogue_appeals()}
            </p>
          ) : null}
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
            <WorkbenchHistoryUnavailable
              onReturn={() => onSearch(returnFromWorkbenchHistory(search))}
              {...(onRetry ? { onRetry } : {})}
            />
          ) : search.queue === 'appeals' && search.case && queueScope?.kind === 'board' ? (
            <WorkbenchAppeal
              appealId={search.case}
              page={{
                state: page.state,
                appeals: page.appeals ?? [],
                selectedTarget: page.selectedTarget ?? null,
              }}
              queueHref={localizeHref(workbenchQueueHref(workbenchSearch({ ...search, case: '' })))}
              {...(isCurrent ? { isCurrent } : {})}
              {...(onRetry ? { onRetry } : {})}
              {...(onRestart ? { onRestart } : {})}
            />
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
                  />
                ))}
              </ul>
            </>
          )}
          {!search.history && !search.case && next ? (
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
