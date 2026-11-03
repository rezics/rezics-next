import { useEffect } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { m } from '../../paraglide/messages.js';
import { localizeHref } from '../../paraglide/runtime.js';
import { PageHeading } from '../../shell/page-heading';
import { openWorkbenchHistory, returnFromWorkbenchHistory, WorkbenchHistoryUnavailable } from '../workbench-history';
import {
  workbenchCaseHref,
  workbenchScope,
  workbenchSearch,
  workbenchWithoutContinuation,
  type WorkbenchSearch,
} from './scope';
import { workbenchQueueScope, type WorkbenchCase, type WorkbenchDirectoryItem, type WorkbenchRead } from './read';

const control =
  'inline-flex h-auto min-h-11 min-w-11 max-w-full items-center justify-center whitespace-normal break-words px-3 py-2 focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

export type WorkbenchViewProps = {
  page: Pick<WorkbenchRead, 'state' | 'realms' | 'realmsNext' | 'boards' | 'boardsNext' | 'cases' | 'next' | 'search'>;
  onSearch: (search: WorkbenchSearch) => void;
  onRetry?: () => void;
};

function labelOf(item: WorkbenchDirectoryItem): string {
  return item.title?.trim() || m.moderation_target_unavailable();
}

function CaseRow({ item, search }: { item: WorkbenchCase; search: WorkbenchSearch }) {
  const scope = workbenchQueueScope(search);
  if (!scope) return null;
  const href = localizeHref(workbenchCaseHref(scope, item.kind));
  const kindLabel =
    item.kind === 'appeal' ? m.moderation_workbench_queue_appeals() : m.moderation_workbench_queue_reports();
  return (
    <li className="min-w-0 border-b py-3">
      <a className={`${control} justify-start text-left font-medium underline-offset-4 hover:underline`} href={href}>
        {m.moderation_workbench_open_case({ id: item.id })}
      </a>
      <p className="mt-1 text-sm text-muted-foreground">{kindLabel}</p>
      <details className="mt-2 text-sm">
        <summary className={`${control} cursor-pointer justify-start`}>
          {m.moderation_workbench_case_reference()}
        </summary>
        <dl className="mt-2 grid gap-1 [overflow-wrap:anywhere]">
          <div>
            <dt className="text-muted-foreground">
              {item.kind === 'appeal' ? m.moderation_case_details_appeal_id() : m.moderation_queue_details_report_id()}
            </dt>
            <dd>{item.id}</dd>
          </div>
          {item.decisionId ? (
            <div>
              <dt className="text-muted-foreground">{m.moderation_case_details_decision_id()}</dt>
              <dd>{item.decisionId}</dd>
            </div>
          ) : null}
          <div>
            <dt className="text-muted-foreground">{m.moderation_case_details_target_id()}</dt>
            <dd>{item.target.id}</dd>
          </div>
        </dl>
      </details>
      {item.evidence ? <p className="mt-2 max-w-prose text-sm [overflow-wrap:anywhere]">{item.evidence}</p> : null}
      {item.statement ? (
        <blockquote className="mt-2 max-w-prose text-sm [overflow-wrap:anywhere]">{item.statement}</blockquote>
      ) : null}
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

export function WorkbenchView({ page, onSearch, onRetry }: WorkbenchViewProps) {
  const search = page.search;
  const scope = workbenchScope(search);
  const queueScope = workbenchQueueScope(search);
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
          ) : search.queue === 'appeals' && scope.kind === 'catalogue' ? null : page.cases.length === 0 ? (
            <p role="status" className="text-muted-foreground">
              {next ? m.moderation_workbench_empty_next() : m.moderation_workbench_empty()}
            </p>
          ) : (
            <ul className="min-w-0">
              {page.cases.map((item) => (
                <CaseRow key={`${item.kind}:${item.id}`} item={item} search={search} />
              ))}
            </ul>
          )}
          {!search.history && next ? (
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
