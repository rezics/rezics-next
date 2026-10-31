import { ListRow } from '@rezics/ui/list-row';
import { Button } from '@rezics/ui/shadcn/button';
import { Link } from '@tanstack/react-router';
import { Exposure } from '../kernel/exposure';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';
import { fullDateTime } from '../threads/byline';
import type { MyLogsPage } from './my-logs';
import { SubjectCover, rowRatio } from './subject-row';
import { displayLibraryTitle, LibraryTitle } from './title';

function SnapshotDate({ label, value }: { label: string; value: string }) {
  return (
    <span className="[overflow-wrap:anywhere]">
      {label}: <time dateTime={value}>{fullDateTime(value, getLocale())}</time>
    </span>
  );
}

export function MyLogsPageView({
  page,
  cursor,
  onRetry,
}: {
  page: MyLogsPage;
  cursor?: string | undefined;
  onRetry?: () => void;
}) {
  const ratio = rowRatio(page.state === 'loaded' ? page.logs.map((log) => log.subject) : []);
  return (
    <article className="min-w-0 max-w-4xl space-y-6 text-foreground">
      <header className="space-y-2">
        <PageHeading>{m.library_my_logs_heading()}</PageHeading>
        <p className="text-muted-foreground">{m.library_my_logs_description()}</p>
      </header>
      {page.state === 'signed-out' ? (
        <a
          href={`/auth/sign-in?return_to=${encodeURIComponent(`/${getLocale()}/library/logs`)}`}
          className="text-primary underline"
        >
          {m.library_my_logs_sign_in()}
        </a>
      ) : page.state !== 'loaded' ? (
        <div className="space-y-3">
          <p role={page.state === 'preparing' ? 'status' : 'alert'}>
            {page.state === 'denied'
              ? m.library_my_logs_denied()
              : page.state === 'preparing'
                ? m.library_my_logs_preparing()
                : m.library_my_logs_unavailable()}
          </p>
          {onRetry ? (
            <Button variant="outline" onClick={onRetry}>
              {m.library_my_logs_retry()}
            </Button>
          ) : null}
        </div>
      ) : (
        <>
          {page.restarted ? <p role="status">{m.library_my_logs_restarted()}</p> : null}
          {page.logs.length ? (
            <ol aria-label={m.library_logs_heading()} className="space-y-2">
              {page.logs.map((log) => {
                const title = log.subject
                  ? displayLibraryTitle(log.subject.label, getLocale()).text
                  : m.library_subject_unavailable();
                const state =
                  log.sessionState === 'completed'
                    ? m.library_progress_state_completed()
                    : log.sessionState === 'abandoned'
                      ? m.library_progress_state_abandoned()
                      : m.library_progress_state_active();
                return (
                  <ListRow
                    key={log.id}
                    className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-4 gap-y-2 rounded-xl px-3 py-4"
                  >
                    <SubjectCover subject={log.subject} ratio={ratio} />
                    <div className="min-w-0 flex-1 space-y-2">
                      <p className="line-clamp-2 font-semibold [overflow-wrap:anywhere]">
                        {log.subject ? <LibraryTitle label={log.subject.label} locale={getLocale()} /> : title}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {m.library_logs_session_state()}: {state}
                      </p>
                      <div className="flex flex-col gap-1 text-sm text-muted-foreground">
                        <SnapshotDate label={m.library_logs_published()} value={log.publishedAt} />
                        <SnapshotDate label={m.library_logs_started()} value={log.startedAt} />
                        {log.completedAt ? (
                          <SnapshotDate label={m.library_logs_completed()} value={log.completedAt} />
                        ) : null}
                      </div>
                      <Exposure operation="published_log.read">
                        <a
                          href={`/${getLocale()}/logs/${encodeURIComponent(log.id)}`}
                          aria-label={m.library_my_logs_read({ title, date: fullDateTime(log.publishedAt, getLocale()) })}
                          className="inline-flex min-h-11 items-center rounded text-sm text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                        >
                          {m.library_my_logs_open_log()}
                        </a>
                      </Exposure>
                    </div>
                    {log.note ? (
                      <details className="group/note col-span-full min-w-0">
                        <summary className="cursor-pointer list-none rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
                          <span
                            aria-hidden="true"
                            className="line-clamp-3 whitespace-pre-wrap [overflow-wrap:anywhere] group-open/note:hidden"
                          >
                            {log.note}
                          </span>
                          <span className="flex min-h-11 items-center text-sm text-primary underline underline-offset-4">
                            {m.library_my_logs_full_note()}
                          </span>
                        </summary>
                        <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{log.note}</p>
                      </details>
                    ) : null}
                  </ListRow>
                );
              })}
            </ol>
          ) : (
            <p className="text-muted-foreground">
              {page.next || (cursor && !page.restarted) ? m.library_my_logs_no_visible() : m.library_logs_empty()}
            </p>
          )}
          {page.next ? (
            <Exposure operation="published_log.list">
              <Link
                to="/library/logs"
                search={{ cursor: page.next }}
                className="inline-flex min-h-10 items-center rounded-lg border border-border px-4 text-primary hover:bg-muted"
              >
                {m.library_logs_more()}
              </Link>
            </Exposure>
          ) : null}
        </>
      )}
      {cursor || (page.state === 'loaded' && page.restarted) ? (
        <Link
          to="/library/logs"
          search={{}}
          className="inline-flex min-h-10 items-center text-primary underline-offset-4 hover:underline"
        >
          {m.library_my_logs_newest()}
        </Link>
      ) : null}
    </article>
  );
}
