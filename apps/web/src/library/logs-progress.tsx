import { Exposure, useOperation } from '../kernel/exposure';
import { getLocale } from '../paraglide/runtime.js';
import { fullDateTime } from '../threads/byline';
import { Link, useRouter } from '@tanstack/react-router';
import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import type { ProgressDetailOrigin } from './progress-session';
import { m } from '../paraglide/messages.js';
import { csrfHeaders } from '../threads/composer';
import { publishProgressLog } from './logs-server';
import type { PublishedLogPage } from './logs-read';
import type { ProgressSessionPage } from './progress-reads';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { Button } from '@rezics/ui/shadcn/button';
import { ContentItem } from '@rezics/ui/content-item';

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

function PublishLog({
  page,
  originating,
}: {
  page: Extract<ProgressSessionPage, { signedIn: true }>;
  originating?: ProgressDetailOrigin | undefined;
}) {
  const router = useRouter();
  const [note, setNote] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  type Lifetime = {
    page: typeof page;
    originating?: ProgressDetailOrigin | undefined;
    pending: boolean;
    intent?: { sessionId: string; note?: string; idempotencyKey: string };
  };
  const lifetime = useRef<Lifetime | null>({ page, originating, pending: false });
  const [seenPage, setSeenPage] = useState(page);
  const originChanged = lifetime.current !== null && lifetime.current.originating !== originating;
  if (page !== seenPage || originChanged) {
    setSeenPage(page);
    if (!originating || originChanged) {
      lifetime.current = { page, originating, pending: false };
      setNote('');
      setIdempotencyKey(crypto.randomUUID());
      setPending(false);
      setError(null);
    }
  }
  useLayoutEffect(() => {
    const origin = (lifetime.current ??= { page, originating, pending: false });
    return () => {
      if (lifetime.current === origin) lifetime.current = null;
    };
  }, [originating ?? page]);

  function isCurrent(origin: Lifetime | null): origin is Lifetime {
    return Boolean(
      origin &&
      lifetime.current === origin &&
      origin.originating === originating &&
      (originating ? originating.isCurrent(true) : origin.page === page),
    );
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const origin = lifetime.current;
    if (!isCurrent(origin) || origin.pending) return;
    const cleanNote = note.trim();
    origin.intent ??= { sessionId: page.session.id, ...(cleanNote ? { note: cleanNote } : {}), idempotencyKey };
    origin.pending = true;
    setPending(true);
    setError(null);
    try {
      const result = await publishProgressLog({ data: origin.intent, headers: csrfHeaders() });
      if (!isCurrent(origin)) return;
      if (!result.ok) {
        setError(result.reason === 'closed' ? m.platform_closed_message() : m.library_logs_write_failed());
        return;
      }
      delete origin.intent;
      setIdempotencyKey(crypto.randomUUID());
      if (!isCurrent(origin)) return;
      window.location.assign(router.buildLocation({ to: '/logs/$id', params: { id: result.id } }).href);
    } catch {
      if (!isCurrent(origin)) return;
      setError(m.library_logs_write_failed());
    } finally {
      if (isCurrent(origin)) {
        origin.pending = false;
        setPending(false);
      }
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
  const headingId = 'published-logs-heading';
  const canRead = useOperation('published_log.read');

  return (
    <section role="region" aria-labelledby={headingId} className="space-y-3">
      <h2 id={headingId} className="text-xl font-semibold">
        {m.library_logs_heading()}
      </h2>
      {page.logs.length ? (
        <ol className="space-y-3">
          {page.logs.map((log) => (
            <ContentItem
              key={log.id}
              title={
                [log.account?.displayName, log.account?.handle ? `@${log.account.handle}` : null]
                  .filter(Boolean)
                  .join(' ') || m.library_account_deleted()
              }
              headingLevel={3}
              {...(canRead ? { href: `/${getLocale()}/logs/${encodeURIComponent(log.id)}` } : {})}
              metadata={<RelativeTime value={log.publishedAt} />}
              preview={log.note ? <p className="whitespace-pre-wrap">{log.note}</p> : null}
            />
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
  originating,
}: {
  progress: ProgressSessionPage;
  logs: PublishedLogPage;
  search: { changes?: string; units?: string; logs?: string };
  originating?: ProgressDetailOrigin | undefined;
}) {
  const page = progress as Extract<ProgressSessionPage, { signedIn: true }>;
  return (
    <>
      <PublishLog page={page} originating={originating} />
      <PublishedLogs
        page={logs}
        sessionId={page.session.id}
        search={{
          ...(search.changes ? { changes: search.changes } : {}),
          ...(search.units ? { units: search.units } : {}),
        }}
      />
    </>
  );
}
