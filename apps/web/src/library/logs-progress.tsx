import { Exposure, useOperation } from '../kernel/exposure';
import { getLocale } from '../paraglide/runtime.js';
import { fullDateTime } from '../threads/byline';
import { Link, useRouter } from '@tanstack/react-router';
import { useId, useLayoutEffect, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import type { ProgressDetailOrigin } from './progress-session';
import { m } from '../paraglide/messages.js';
import { csrfHeaders } from '../threads/composer';
import { publishProgressLog } from './logs-server';
import type { PublishedLogPage, PublishedLogWriteResult } from './logs-read';
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

type PublicationIntent = { sessionId: string; note?: string; idempotencyKey: string };
type PublicationLifetime = {
  sessionId: string;
  note: string;
  key: string;
  intent?: PublicationIntent;
  flight?: object;
  success?: Extract<PublishedLogWriteResult, { ok: true }>;
  error: string | null;
  listeners: Set<() => void>;
};
// Private same-owner intent survives a retired read/operation view. This is never authority.
const publications = new WeakMap<object, PublicationLifetime>();
function publicationLifetime(sessionId: string, originating?: ProgressDetailOrigin): PublicationLifetime {
  const key = originating?.lifetime ?? originating;
  const retained = key ? publications.get(key) : undefined;
  if (retained?.sessionId === sessionId) return retained;
  const value: PublicationLifetime = {
    sessionId,
    note: '',
    key: crypto.randomUUID(),
    error: null,
    listeners: new Set(),
  };
  if (key) publications.set(key, value);
  return value;
}

function PublishLog({
  page,
  originating,
}: {
  page: Extract<ProgressSessionPage, { signedIn: true }>;
  originating?: ProgressDetailOrigin | undefined;
}) {
  const router = useRouter();
  const [, render] = useState(0);
  const owner = useRef<{ page: typeof page; originating: typeof originating; value: PublicationLifetime } | null>(null);
  if (!owner.current || owner.current.originating !== originating || (!originating && owner.current.page !== page))
    owner.current = { page, originating, value: publicationLifetime(page.session.id, originating) };
  const lifetime = owner.current.value;
  const mounted = useRef(0);
  const guard = originating?.capture?.('published_log.create');
  const renderToken = {};
  const currentView = useRef<{ token: object; current: () => boolean } | null>(null);
  const isCurrent = () =>
    mounted.current > 0 &&
    owner.current?.value === lifetime &&
    owner.current.originating === originating &&
    (guard ? guard.isCurrent() : originating ? originating.isCurrent(true) : owner.current.page === page);
  currentView.current = { token: renderToken, current: isCurrent };
  const canHandle = () => currentView.current?.token === renderToken && isCurrent();

  useLayoutEffect(() => {
    mounted.current++;
    const notify = () => {
      // A retired completion may release its own physical latch. Only the current
      // observing view can reflect that settlement in the UI, after checking authority.
      if (owner.current?.value === lifetime && currentView.current?.current()) render((value) => value + 1);
    };
    lifetime.listeners.add(notify);
    return () => {
      mounted.current--;
      lifetime.listeners.delete(notify);
    };
  }, [lifetime]);
  function notify() {
    lifetime.listeners.forEach((listener) => listener());
  }
  function navigate(id: string) {
    if (isCurrent()) window.location.assign(router.buildLocation({ to: '/logs/$id', params: { id } }).href);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canHandle() || lifetime.flight) return;
    const headers = guard ? guard.headers() : csrfHeaders();
    if (!headers) return;
    // A success observed during an authority pause remains a success. Explicitly
    // resuming it may navigate, but must never publish the same intent with a fresh key.
    if (lifetime.success) {
      navigate(lifetime.success.id);
      return;
    }
    const cleanNote = lifetime.note.trim();
    lifetime.intent ??= {
      sessionId: lifetime.sessionId,
      ...(cleanNote ? { note: cleanNote } : {}),
      idempotencyKey: lifetime.key,
    };
    const intent = lifetime.intent;
    const flight = {};
    lifetime.flight = flight;
    lifetime.error = null;
    notify();
    const currentAttempt = () => lifetime.flight === flight && isCurrent();
    try {
      const result = await publishProgressLog({ data: intent, headers });
      // Record the actual native outcome privately, even when this view has retired.
      // No replacement viewer can acquire this lifetime or its result.
      if (result.ok && lifetime.flight === flight) lifetime.success = result;
      if (!currentAttempt()) return;
      if (!result.ok) {
        lifetime.error = result.reason === 'closed' ? m.platform_closed_message() : m.library_logs_write_failed();
        notify();
        return;
      }
      navigate(result.id);
    } catch {
      if (!currentAttempt()) return;
      lifetime.error = m.library_logs_write_failed();
      notify();
    } finally {
      // Authority is not the owner of physical completion. This cannot release a
      // different lifetime's or a newer request's latch, and never retries a write.
      if (lifetime.flight === flight) {
        delete lifetime.flight;
        notify();
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
              value={lifetime.note}
              onChange={(event) => {
                if (!canHandle()) return;
                lifetime.note = event.target.value;
                notify();
              }}
            />
          </label>
          {lifetime.error ? (
            <p role="alert" className="rounded-lg border border-border bg-card p-3">
              {lifetime.error}
            </p>
          ) : null}
          <Button type="submit" disabled={!!lifetime.flight}>
            {m.library_logs_publish()}
          </Button>
        </form>
      </Exposure>
    </section>
  );
}

function PublishedLogNote({ note }: { note: string }) {
  const [expanded, setExpanded] = useState(false);
  const noteId = useId();
  return (
    <div className="min-w-0 space-y-1">
      <p
        id={noteId}
        className={`whitespace-pre-wrap [overflow-wrap:anywhere] ${expanded ? 'relative z-10' : 'line-clamp-3'}`}
      >
        {note}
      </p>
      <Button
        type="button"
        variant="ghost"
        className="min-h-11 max-w-full whitespace-normal text-start"
        aria-expanded={expanded}
        aria-controls={noteId}
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? m.library_progress_log_reader_collapse_note() : m.library_progress_log_reader_full_note()}
      </Button>
    </div>
  );
}

function PublishedLogs({
  page,
  sessionId,
  search,
  originating,
}: {
  page: PublishedLogPage;
  sessionId: string;
  search: { changes?: string; units?: string; logs?: string };
  originating?: ProgressDetailOrigin | undefined;
}) {
  const headingId = 'published-logs-heading';
  const canRead = useOperation('published_log.read');
  const [mounted, setMounted] = useState(false);
  useLayoutEffect(() => {
    // The supplied origin becomes current only after its owning view mounts.
    setMounted(true);
  }, []);
  const navigation = originating?.capture?.('published_log.list');
  const isCurrent = () => (navigation ? navigation.isCurrent() : originating ? originating.isCurrent() : true);
  const guardNavigation = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!isCurrent()) event.preventDefault();
  };
  const sessionSearch = {
    ...(search.changes !== undefined ? { changes: search.changes } : {}),
    ...(search.units !== undefined ? { units: search.units } : {}),
  };
  const occurrences = new Map<string, number>();

  return (
    <section role="region" aria-labelledby={headingId} className="min-w-0 space-y-3">
      <h2 id={headingId} className="text-xl font-semibold">
        {m.library_logs_heading()}
      </h2>
      {page.logs.length ? (
        <ol className="space-y-3">
          {page.logs.map((log) => {
            const occurrence = occurrences.get(log.id) ?? 0;
            occurrences.set(log.id, occurrence + 1);
            return (
              <ContentItem
                key={JSON.stringify([log.id, occurrence])}
                className="[&_h3]:[overflow-wrap:anywhere]"
                title={
                  [log.account?.displayName, log.account?.handle ? `@${log.account.handle}` : null]
                    .filter(Boolean)
                    .join(' ') || m.library_account_deleted()
                }
                headingLevel={3}
                {...(canRead ? { href: `/${getLocale()}/logs/${encodeURIComponent(log.id)}` } : {})}
                metadata={<RelativeTime value={log.publishedAt} />}
                preview={log.note ? <PublishedLogNote note={log.note} /> : null}
              />
            );
          })}
        </ol>
      ) : (
        <p className="text-muted-foreground">
          {search.logs || page.next ? m.library_progress_log_reader_page_empty() : m.library_logs_empty()}
        </p>
      )}
      {(!originating || mounted) && isCurrent() && (search.logs || page.next) ? (
        <Exposure operation="published_log.list">
          <div className="flex flex-wrap gap-2">
            {search.logs ? (
              <Link
                to="/library/progress/$id"
                params={{ id: sessionId }}
                search={sessionSearch}
                onClick={guardNavigation}
                onAuxClick={guardNavigation}
                onContextMenu={guardNavigation}
                className={`${buttonClass} min-h-11 max-w-full`}
              >
                {m.library_progress_log_reader_first_page()}
              </Link>
            ) : null}
            {page.next ? (
              <Link
                to="/library/progress/$id"
                params={{ id: sessionId }}
                search={{
                  logs: page.next,
                  ...sessionSearch,
                }}
                onClick={guardNavigation}
                onAuxClick={guardNavigation}
                onContextMenu={guardNavigation}
                className={`${buttonClass} min-h-11 max-w-full`}
              >
                {m.library_logs_more()}
              </Link>
            ) : null}
          </div>
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
      <PublishedLogs page={logs} sessionId={page.session.id} search={search} originating={originating} />
    </>
  );
}
