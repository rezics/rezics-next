import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { localizeHref } from '../../paraglide/runtime.js';
import { moderationDirectoryPage, type ModerationDirectoryPage } from './directory';
import { workbenchDirectorySearch, workbenchSearch, type WorkbenchSearch } from './scope';

const control = 'min-h-11 min-w-11 max-w-full whitespace-normal break-words text-left';

/** Only source advice creates a selection control. Exact selected reads remain independent. */
export function ModerationDirectory({
  page,
  search,
  onSearch,
  onRetry,
  isCurrent,
}: {
  page?: ModerationDirectoryPage | undefined;
  search: WorkbenchSearch;
  onSearch: (search: WorkbenchSearch) => void;
  onRetry?: (event?: MouseEvent<HTMLButtonElement>) => void;
  isCurrent?: () => boolean;
}) {
  const [, setExpired] = useState(0);
  const current = useRef(page);
  current.current = page;
  const observation = moderationDirectoryPage(page);
  useEffect(() => {
    if (observation.state !== 'ready') return;
    const timer = setTimeout(
      () => setExpired((version) => version + 1),
      Math.max(0, Date.parse(observation.validUntil) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [page]);
  useEffect(() => {
    current.current = page;
    return () => {
      if (current.current === page) current.current = undefined;
    };
  }, [page]);
  const live = () =>
    current.current === page &&
    (!isCurrent || isCurrent()) &&
    page?.state === 'ready' &&
    Date.now() < Date.parse(page.validUntil);
  if (observation.state !== 'ready') {
    const message =
      observation.state === 'preparing'
        ? m.moderation_directory_preparing()
        : observation.state === 'denied'
          ? m.moderation_workbench_denied()
          : observation.state === 'stale'
            ? m.moderation_directory_expired()
            : search.directoryCursor
              ? m.moderation_directory_continuation_failed()
              : m.moderation_directory_unavailable();
    return (
      <section aria-label={m.moderation_directory_heading()} className="space-y-3">
        <h2 className="text-xl font-semibold">{m.moderation_directory_heading()}</h2>
        <p role={observation.state === 'unavailable' ? 'alert' : 'status'}>{message}</p>
        {onRetry && observation.state !== 'denied' && observation.state !== 'stale' ? (
          <Button data-workbench-retry className={control} onClick={onRetry}>
            {m.moderation_queue_retry()}
          </Button>
        ) : null}
        {observation.state === 'stale' ? (
          <Button
            className={control}
            onClick={() => {
              if (!isCurrent || isCurrent()) onSearch(workbenchDirectorySearch(search, true));
            }}
          >
            {m.moderation_directory_restart()}
          </Button>
        ) : null}
      </section>
    );
  }
  const next = observation.next;
  return (
    <section aria-label={m.moderation_directory_heading()} className="space-y-3">
      <h2 className="text-xl font-semibold">{m.moderation_directory_heading()}</h2>
      {observation.items.length > 0 ? <p role="status">{m.moderation_directory_ready()}</p> : null}
      {observation.items.length === 0 ? (
        <p role="status">{next ? m.moderation_directory_empty_next() : m.moderation_directory_empty()}</p>
      ) : null}
      <ul className="min-w-0 divide-y">
        {observation.items.map((entry) => {
          const scope = entry.scope;
          const allowed = entry.viewer.open === 'permitted';
          const key = scope.kind === 'board' ? `board:${scope.id}` : 'catalogue';
          return (
            <li key={key} className="min-w-0 space-y-2 py-3">
              <h3 className="break-words font-semibold">{entry.label}</h3>
              {entry.parent ? <p className="break-words text-sm text-muted-foreground">{entry.parent.label}</p> : null}
              <div className="flex min-w-0 flex-wrap gap-2">
                {entry.queues.map((queue) => (
                  <Button
                    key={queue}
                    data-moderation-scope
                    type="button"
                    variant="outline"
                    className={control}
                    disabled={!allowed}
                    aria-describedby={!allowed ? `${key}-advice` : undefined}
                    aria-label={`${entry.label}: ${
                      queue === 'appeals'
                        ? m.moderation_workbench_queue_appeals()
                        : queue === 'resolved'
                          ? m.moderation_workbench_queue_resolved()
                          : m.moderation_workbench_queue_reports()
                    }`}
                    onClick={() => {
                      if (!allowed || !live()) return;
                      onSearch(
                        workbenchSearch({
                          queue,
                          order: 'newest',
                          directory: true,
                          directoryCursor: search.directoryCursor,
                          directoryRealm: search.realm,
                          ...(scope.kind === 'board'
                            ? { board: scope.id, ...(entry.parent ? { realm: entry.parent.id } : {}) }
                            : { scope: 'catalogue' }),
                        }),
                      );
                    }}
                  >
                    {queue === 'appeals'
                      ? m.moderation_workbench_queue_appeals()
                      : queue === 'resolved'
                        ? m.moderation_workbench_queue_resolved()
                        : m.moderation_workbench_queue_reports()}
                  </Button>
                ))}
              </div>
              {!allowed ? (
                <p id={`${key}-advice`} role="status">
                  {entry.viewer.open === 'denied'
                    ? m.moderation_workbench_denied()
                    : m.moderation_directory_unavailable()}
                </p>
              ) : null}
              {allowed ? (
                <a
                  className="inline-flex min-h-11 items-center break-words underline"
                  href={localizeHref(
                    scope.kind === 'board' ? `/boards/${encodeURIComponent(scope.id)}` : '/moderation/catalogue',
                  )}
                  onClick={(event) => {
                    if (!live()) event.preventDefault();
                  }}
                >
                  {m.moderation_directory_open_scope({ label: entry.label })}
                </a>
              ) : null}
            </li>
          );
        })}
      </ul>
      {next ? (
        <Button
          type="button"
          className={control}
          onClick={() => {
            if (live()) onSearch(workbenchSearch({ ...search, directoryCursor: next }));
          }}
        >
          {m.threads_next_page()}
        </Button>
      ) : null}
    </section>
  );
}
