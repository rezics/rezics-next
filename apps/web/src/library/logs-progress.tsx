import { Exposure } from '../kernel/exposure';
import { getLocale } from '../paraglide/runtime.js';
import { fullDateTime } from '../threads/byline';
import { Link, useRouter } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { m } from '../paraglide/messages.js';
import { csrfHeaders } from '../threads/composer';
import { publishProgressLog } from './logs-server';
import type { PublishedLogPage } from './logs-read';
import type { ProgressSessionPage } from './progress-reads';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { Button } from '@rezics/ui/shadcn/button';

const buttonClass =
  'inline-flex min-h-10 items-center rounded-lg border border-border px-4 text-primary underline-offset-4 hover:bg-muted';

export function RelativeTime({ value }: { value: string }) {
  const locale = getLocale();
  const delta = new Date(value).getTime() - Date.now();
  const distance = Math.abs(delta);
  const [unit, size] =
    distance < 60_000
      ? (['second', 1_000] as const)
      : distance < 3_600_000
        ? (['minute', 60_000] as const)
        : distance < 86_400_000
          ? (['hour', 3_600_000] as const)
          : distance < 2_592_000_000
            ? (['day', 86_400_000] as const)
            : distance < 31_536_000_000
              ? (['month', 2_592_000_000] as const)
              : (['year', 31_536_000_000] as const);
  return (
    <time dateTime={value} title={fullDateTime(value, locale)}>
      {new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(Math.round(delta / size), unit)}
    </time>
  );
}

function PublishLog({ page }: { page: Extract<ProgressSessionPage, { signedIn: true }> }) {
  const router = useRouter();
  const [note, setNote] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const cleanNote = note.trim();
      const result = await publishProgressLog({
        data: {
          sessionId: page.session.id,
          ...(cleanNote ? { note: cleanNote } : {}),
          idempotencyKey,
        },
        headers: csrfHeaders(),
      });
      if (!result.ok) {
        setError(result.reason === 'closed' ? m.platform_closed_message() : m.library_logs_write_failed());
        return;
      }
      setIdempotencyKey(crypto.randomUUID());
      window.location.assign(router.buildLocation({ to: '/logs/$id', params: { id: result.id } }).href);
    } catch {
      setError(m.library_logs_write_failed());
    } finally {
      setPending(false);
    }
  }

  return (
    <section aria-labelledby="publish-log-heading" className="space-y-3">
      <h2 id="publish-log-heading" className="text-xl font-semibold">
        {m.library_logs_publish_heading()}
      </h2>
      <p>{m.library_logs_description()}</p>
      <Exposure operation="published_log.create">
        <form className="space-y-3" onSubmit={(event) => void submit(event)}>
          <label className="block space-y-1">
            <span className="text-sm font-medium">{m.library_logs_publish_note()}</span>
            <Textarea
              aria-label={m.library_logs_publish_note()}
              maxLength={1000}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          {error ? (
            <p role="alert" className="rounded-lg border border-border bg-card p-3">
              {error}
            </p>
          ) : null}
          <Button type="submit" disabled={pending}>
            {m.library_logs_publish()}
          </Button>
        </form>
      </Exposure>
    </section>
  );
}

function PublishedLogs({
  page,
  sessionId,
  search,
}: {
  page: PublishedLogPage;
  sessionId: string;
  search: { changes?: string; units?: string };
}) {
  if (!page.signedIn) return null;
  const headingId = 'published-logs-heading';

  return (
    <section role="region" aria-labelledby={headingId} className="space-y-3">
      <h2 id={headingId} className="text-xl font-semibold">
        {m.library_logs_heading()}
      </h2>
      {page.logs.length ? (
        <ol className="divide-y divide-border/60 border-y border-border/60">
          {page.logs.map((log) => (
            <li key={log.id} className="space-y-2 py-3">
              <p className="flex min-w-0 items-baseline gap-2 overflow-hidden text-sm whitespace-nowrap">
                {log.account ? (
                  <>
                    {log.account.displayName ? (
                      <span className="truncate font-medium">{log.account.displayName}</span>
                    ) : null}
                    {log.account.handle ? (
                      <span className="shrink-0 text-muted-foreground">@{log.account.handle}</span>
                    ) : null}
                  </>
                ) : (
                  <span className="truncate font-medium">{m.library_account_deleted()}</span>
                )}
                <span className="shrink-0 text-muted-foreground">
                  <RelativeTime value={log.publishedAt} />
                </span>
              </p>
              {log.note ? <p className="whitespace-pre-wrap">{log.note}</p> : null}
              <p>
                <Exposure operation="published_log.read">
                  <Link
                    to="/logs/$id"
                    params={{ id: log.id }}
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    {m.library_logs_open()}
                  </Link>
                </Exposure>
              </p>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-muted-foreground">{m.library_logs_empty()}</p>
      )}
      {page.next ? (
        <Exposure operation="published_log.list">
          <Link
            to="/library/progress/$id"
            params={{ id: sessionId }}
            search={{
              logs: page.next,
              ...(search.changes ? { changes: search.changes } : {}),
              ...(search.units ? { units: search.units } : {}),
            }}
            className={buttonClass}
          >
            {m.library_logs_more()}
          </Link>
        </Exposure>
      ) : null}
    </section>
  );
}

export function ProgressLogs({
  progress,
  logs,
  search,
}: {
  progress: ProgressSessionPage;
  logs: PublishedLogPage;
  search: { changes?: string; units?: string; logs?: string };
}) {
  if (!progress.signedIn) return null;
  return (
    <>
      <PublishLog page={progress} />
      <PublishedLogs
        page={logs}
        sessionId={progress.session.id}
        search={{
          ...(search.changes ? { changes: search.changes } : {}),
          ...(search.units ? { units: search.units } : {}),
        }}
      />
    </>
  );
}
