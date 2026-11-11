import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@rezics/ui/shadcn/select';
import { useId, type MouseEvent } from 'react';
import type { WorkbenchWindowMove, WorkbenchWindowView } from '../workbench-queue/window-history';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { getLocale, localizeHref } from '../../paraglide/runtime.js';
import { threadLocation } from '../../threads/thread-href';
import { workbenchSearch, type WorkbenchSearch } from '../workbench-queue/scope';
import type { HistoryRead } from './read';

const control =
  'inline-flex h-auto min-h-11 min-w-11 max-w-full items-center justify-center whitespace-normal break-words px-3 py-2 focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

export function WorkbenchHistoryUnavailable({ onReturn, onRetry }: { onReturn: () => void; onRetry?: () => void }) {
  return (
    <section className="space-y-3" aria-labelledby="workbench-history-heading">
      <h2 id="workbench-history-heading" tabIndex={-1} className="text-xl font-semibold">
        {m.moderation_workbench_history()}
      </h2>
      <p role="alert" className="max-w-prose text-muted-foreground">
        {m.moderation_workbench_history_unavailable()}
      </p>
      <div className="flex min-w-0 flex-wrap gap-2">
        {onRetry ? (
          <Button type="button" variant="outline" className={control} onClick={onRetry}>
            {m.moderation_queue_retry()}
          </Button>
        ) : null}
        <Button type="button" className={control} onClick={onReturn}>
          {m.moderation_workbench_history_return()}
        </Button>
      </div>
    </section>
  );
}

function time(value: string) {
  return (
    <time dateTime={value}>
      {new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))}
    </time>
  );
}

/** Board moderation receipts deliberately have no author appeal controls. All
 * current navigation comes from the selected exact reader's native context. */
function SelectedReceipt({ selected }: { selected: NonNullable<HistoryRead['selected']> }) {
  if (selected.state !== 'ready') return <p role="status">{m.moderation_history_receipt_unavailable()}</p>;
  const decision = selected.decision;
  const context = decision.targetContext;
  return (
    <section aria-labelledby="history-receipt-heading" className="min-w-0 space-y-3 rounded-lg border p-4">
      <h3 id="history-receipt-heading" className="text-lg font-semibold">
        {m.moderation_history_receipt()}
      </h3>
      <dl className="space-y-2">
        <div>
          <dt>{m.moderation_case_details_decision_id()}</dt>
          <dd className="break-all">{decision.id}</dd>
        </div>
        <div>
          <dt>{m.moderation_case_details_target_id()}</dt>
          <dd className="break-all">{decision.targetId}</dd>
        </div>
        <div>
          <dt>{m.moderation_history_time()}</dt>
          <dd>{time(decision.decidedAt)}</dd>
        </div>
        <div>
          <dt>{m.moderation_reason_label()}</dt>
          <dd className="whitespace-pre-wrap break-words" dir="auto">
            {decision.statement || m.moderation_history_reason_unavailable()}
          </dd>
        </div>
      </dl>
      {context.state === 'available' ? (
        <a
          className={`${control} underline`}
          href={
            context.kind === 'board'
              ? localizeHref(`/boards/${encodeURIComponent(context.boardId)}`)
              : threadLocation(
                  getLocale(),
                  { id: context.threadId, title: context.threadTitle },
                  undefined,
                  context.postId ?? undefined,
                )
          }
        >
          {m.moderation_current_target_label()}
        </a>
      ) : (
        <p role="status">
          {context.state === 'concealed' ? m.moderation_target_withheld() : m.moderation_target_unavailable()}
        </p>
      )}
    </section>
  );
}

export function WorkbenchHistory({
  page,
  search,
  onSearch,
  onReturn,
  onRetry,
  windows,
  onMove,
  onClose,
}: {
  windows?: WorkbenchWindowView | undefined;
  onMove?: ((move: WorkbenchWindowMove | 'retry', source?: HTMLButtonElement, keyboard?: boolean) => void) | undefined;
  onClose?: ((source: HTMLButtonElement, keyboard: boolean) => void) | undefined;
  page: HistoryRead;
  search: WorkbenchSearch;
  onSearch: (search: WorkbenchSearch) => void;
  onReturn: () => void;
  onRetry?: () => void;
}) {
  const filterId = useId();
  function move(kind: WorkbenchWindowMove | 'retry', event: MouseEvent<HTMLButtonElement>) {
    onMove?.(kind, event.currentTarget, event.detail === 0);
  }
  const restart = () => onSearch(workbenchSearch({ ...search, historyCursor: undefined, historyDecision: undefined }));
  const status =
    page.state === 'denied'
      ? m.moderation_workbench_denied()
      : page.state === 'stale'
        ? m.moderation_workbench_stale()
        : m.moderation_workbench_history_unavailable();
  return (
    <section aria-labelledby="workbench-history-heading" className="min-w-0 space-y-4 [overflow-wrap:anywhere]">
      <h2 id="workbench-history-heading" tabIndex={-1} className="text-xl font-semibold">
        {m.moderation_workbench_history()}
      </h2>
      <p className="max-w-prose text-muted-foreground">{m.moderation_history_private()}</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" className={control} onClick={onReturn}>
          {m.moderation_workbench_history_return()}
        </Button>
        {page.state === 'stale' ? (
          <Button
            type="button"
            variant="outline"
            className={control}
            onClick={(event) => (onMove ? move('first', event) : restart())}
          >
            {m.moderation_queue_restart()}
          </Button>
        ) : page.state === 'unavailable' && onRetry ? (
          <Button
            data-workbench-retry
            type="button"
            variant="outline"
            className={control}
            onClick={(event) => (onMove ? move('retry', event) : onRetry?.())}
          >
            {m.moderation_queue_retry()}
          </Button>
        ) : null}
      </div>
      {windows && page.state !== 'denied' ? (
        <div className="flex min-w-0 flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            className={control}
            disabled={!windows.previous}
            onClick={(event) => move('previous', event)}
          >
            {m.moderation_workbench_previous()}
          </Button>
          <Button
            type="button"
            variant="outline"
            className={control}
            disabled={!windows.refresh}
            onClick={(event) => move('refresh', event)}
          >
            {m.moderation_workbench_refresh_window()}
          </Button>
          <Button
            type="button"
            variant="outline"
            className={control}
            disabled={!windows.first}
            onClick={(event) => move('first', event)}
          >
            {m.moderation_workbench_first()}
          </Button>
        </div>
      ) : null}
      {page.state !== 'ready' ? (
        <p role={page.state === 'denied' ? 'status' : 'alert'}>{status}</p>
      ) : (
        <>
          <Field className="grid max-w-sm gap-1">
            <FieldLabel htmlFor={`${filterId}-kind`}>{m.moderation_workbench_triage_target_kind()}</FieldLabel>
            <Select
              items={[
                { value: 'all', label: m.moderation_filter_all_kinds() },
                { value: 'board', label: m.moderation_history_board() },
                { value: 'thread', label: m.moderation_history_thread() },
                { value: 'post', label: m.moderation_history_post() },
              ]}
              value={search.historyTargetKind ?? 'all'}
              onValueChange={(value) =>
                onSearch(
                  workbenchSearch({
                    ...search,
                    historyTargetKind: value!,
                    historyCursor: undefined,
                    historyDecision: undefined,
                  }),
                )
              }
            >
              <SelectTrigger id={`${filterId}-kind`} className="min-h-11">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="all">{m.moderation_filter_all_kinds()}</SelectItem>
                  <SelectItem value="board">{m.moderation_history_board()}</SelectItem>
                  <SelectItem value="thread">{m.moderation_history_thread()}</SelectItem>
                  <SelectItem value="post">{m.moderation_history_post()}</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          {page.entries.length === 0 ? (
            <p role="status">{page.next ? m.moderation_workbench_empty_next() : m.moderation_history_empty()}</p>
          ) : (
            <ol className="min-w-0 divide-y rounded-lg border px-4">
              {page.entries.map((entry) => (
                <li key={entry.id} className="min-w-0 space-y-2 py-4">
                  <p className="font-medium">
                    {m.moderation_history_takedown()} · {time(entry.decidedAt)}
                  </p>
                  <p>
                    {entry.targetKind === 'board'
                      ? m.moderation_history_board()
                      : entry.targetKind === 'thread'
                        ? m.moderation_history_thread()
                        : m.moderation_history_post()}
                    : <span className="break-all">{entry.targetId}</span>
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {entry.history.decider === 'retired'
                      ? m.moderation_history_actor_retired()
                      : m.moderation_history_actor_withheld()}
                  </p>
                  <p className="whitespace-pre-wrap break-words" dir="auto">
                    {entry.history.reasonState === 'retired'
                      ? m.moderation_history_reason_retired()
                      : entry.statement || m.moderation_history_reason_empty()}
                  </p>
                  <p className="text-sm text-muted-foreground">{m.moderation_history_target_unavailable()}</p>
                  {entry.history.receipt === 'permitted' ? (
                    <Button
                      type="button"
                      className={control}
                      variant="outline"
                      data-history-receipt={entry.id}
                      aria-expanded={search.historyDecision === entry.id}
                      onClick={() => onSearch(workbenchSearch({ ...search, historyDecision: entry.id }))}
                    >
                      {m.moderation_history_open_receipt()}
                    </Button>
                  ) : (
                    <p className="text-sm">{m.moderation_history_receipt_unavailable()}</p>
                  )}
                </li>
              ))}
            </ol>
          )}
          {search.historyDecision ? (
            <div className="space-y-3">
              <SelectedReceipt selected={page.selected ?? { state: 'unavailable' }} />
              <Button
                type="button"
                variant="outline"
                className={control}
                onClick={(event) =>
                  onClose
                    ? onClose(event.currentTarget, event.detail === 0)
                    : onSearch(workbenchSearch({ ...search, historyDecision: undefined }))
                }
              >
                {m.moderation_history_close_receipt()}
              </Button>
              {page.selected?.state !== 'ready' && onRetry ? (
                <Button type="button" variant="outline" className={control} onClick={onRetry}>
                  {m.moderation_queue_retry()}
                </Button>
              ) : null}
            </div>
          ) : null}
          {page.next ? (
            <Button
              type="button"
              className={control}
              onClick={(event) =>
                onMove
                  ? move('next', event)
                  : onSearch(workbenchSearch({ ...search, historyCursor: page.next, historyDecision: undefined }))
              }
            >
              {m.threads_next_page()}
            </Button>
          ) : null}
        </>
      )}
    </section>
  );
}
