import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { readerSessionSource } from '../reader/lifetime';
import { useSession } from '../session/query';
import { knowledgeDiscoveryExactHref, type KnowledgeDiscoveryDocument } from './discovery';
import { readKnowledgeDiscoveryPage } from './discovery-read';
import {
  KnowledgeDiscoveryReading,
  parseKnowledgeDiscoveryReturn,
  type KnowledgeDiscoveryBinding,
  type KnowledgeDiscoverySnapshot,
} from './discovery-visit';

const ignoreSubscribe = () => () => {};
const idleSnapshot: KnowledgeDiscoverySnapshot = { state: 'preparing', cursor: null, busy: true };
const controlClass =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal break-words px-4 py-2 text-start leading-snug [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
const linkClass =
  'inline-flex min-h-11 min-w-11 max-w-full items-center rounded-sm py-2 text-primary underline underline-offset-4 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

function localeOptions(locale: string) {
  return { locale: locale as never };
}

function publicationTime(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(
    new Date(value),
  );
}

export function KnowledgeDiscoveryReturnLink({ href, locale }: { href: string; locale: string }) {
  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl px-4 pt-4 sm:px-6">
      <a href={href} className={linkClass}>
        {m.knowledge_discovery_return({}, localeOptions(locale))}
      </a>
    </div>
  );
}

function DiscoveryNotice({
  locale,
  message,
  alert,
  action,
  actionLabel,
  busy,
}: {
  locale: string;
  message: string;
  alert?: boolean | undefined;
  action?: (() => void) | undefined;
  actionLabel?: string | undefined;
  busy: boolean;
}) {
  return (
    <div
      role={alert ? 'alert' : 'status'}
      className="min-w-0 space-y-3 text-sm text-muted-foreground"
      aria-live="polite"
    >
      <p className="min-w-0 break-words">{message}</p>
      {action && actionLabel ? (
        <Button type="button" variant="outline" className={controlClass} disabled={busy} onClick={action}>
          {busy ? m.knowledge_discovery_preparing({}, localeOptions(locale)) : actionLabel}
        </Button>
      ) : null}
    </div>
  );
}

function DiscoveryRow({
  locale,
  document,
  returnTo,
}: {
  locale: string;
  document: KnowledgeDiscoveryDocument;
  returnTo: string;
}) {
  const options = localeOptions(locale);
  return (
    <li className="min-w-0 space-y-2 border-t border-border pt-4">
      <a
        href={knowledgeDiscoveryExactHref(locale, document, returnTo)}
        className={`${linkClass} font-medium text-foreground`}
      >
        {document.title}
      </a>
      <dl className="grid min-w-0 gap-2 text-sm text-muted-foreground sm:grid-cols-2">
        <div>
          <dt className="font-medium text-foreground">{m.knowledge_published({}, options)}</dt>
          <dd>
            <time dateTime={document.publishedAt}>{publicationTime(document.publishedAt, locale)}</time>
          </dd>
        </div>
        {document.language ? (
          <div>
            <dt className="font-medium text-foreground">{m.knowledge_language({}, options)}</dt>
            <dd>
              <bdi dir="ltr">{document.language}</bdi>
            </dd>
          </div>
        ) : null}
        <div className={document.language ? 'sm:col-span-2' : undefined}>
          <dt className="font-medium text-foreground">{m.knowledge_licence({}, options)}</dt>
          <dd>{document.licence}</dd>
        </div>
      </dl>
    </li>
  );
}

export type KnowledgeDiscoveryPanelProps = {
  locale: string;
  returnTo: string;
  snapshot: KnowledgeDiscoverySnapshot;
  onMore?: (() => void) | undefined;
  onContinue?: (() => void) | undefined;
  onRetry?: (() => void) | undefined;
  onRestart?: (() => void) | undefined;
};

/** Illustrative and live discovery share this region; native proof stays with Search. */
export function KnowledgeDiscoveryPanel({
  locale,
  returnTo,
  snapshot,
  onMore,
  onContinue,
  onRetry,
  onRestart,
}: KnowledgeDiscoveryPanelProps) {
  const options = localeOptions(locale);
  const headingId = 'subject-knowledge-heading';
  const documents = snapshot.state === 'ready' ? (snapshot.page?.documents ?? []) : [];
  const next = snapshot.state === 'ready' ? (snapshot.page?.next ?? null) : null;
  const exhausted = snapshot.state === 'ready' && next === null;
  const sparse = snapshot.state === 'ready' && documents.length === 0 && next !== null;
  const empty = snapshot.state === 'ready' && documents.length === 0 && next === null;
  const preparingContinuation = snapshot.state === 'preparing' && !!snapshot.frontier;
  const initialPreparing = snapshot.state === 'preparing' && !snapshot.frontier;
  const moreRef = useRef<HTMLButtonElement>(null);
  const endRef = useRef<HTMLParagraphElement>(null);
  const previousMore = useRef(false);

  useLayoutEffect(() => {
    if (previousMore.current && exhausted && endRef.current && document.activeElement === moreRef.current)
      endRef.current.focus();
    previousMore.current = !!next && snapshot.state === 'ready';
  }, [exhausted, next, snapshot.state]);

  return (
    <section
      data-slot="subject-knowledge"
      className="min-w-0 space-y-4 text-foreground selection:bg-primary/20 [overflow-wrap:anywhere]"
      aria-labelledby={headingId}
      aria-busy={snapshot.busy || initialPreparing}
    >
      <header className="min-w-0 space-y-2">
        <h2 id={headingId} className="text-base font-semibold">
          {m.knowledge_discovery_heading({}, options)}
        </h2>
        <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
          {m.knowledge_discovery_intro({}, options)}
        </p>
      </header>
      {initialPreparing ? (
        <p role="status" className="text-sm text-muted-foreground">
          {m.knowledge_discovery_preparing({}, options)}
        </p>
      ) : null}
      {snapshot.state === 'denied' ? (
        <DiscoveryNotice
          locale={locale}
          message={m.knowledge_discovery_denied({}, options)}
          action={onRetry}
          actionLabel={m.knowledge_discovery_retry({}, options)}
          busy={snapshot.busy}
        />
      ) : null}
      {snapshot.state === 'unavailable' ? (
        <DiscoveryNotice
          locale={locale}
          message={m.knowledge_discovery_unavailable({}, options)}
          alert
          action={onRetry}
          actionLabel={m.knowledge_discovery_retry({}, options)}
          busy={snapshot.busy}
        />
      ) : null}
      {snapshot.state === 'restart' ? (
        <DiscoveryNotice
          locale={locale}
          message={m.knowledge_discovery_restart_needed({}, options)}
          alert
          action={onRestart}
          actionLabel={m.knowledge_discovery_restart({}, options)}
          busy={snapshot.busy}
        />
      ) : null}
      {preparingContinuation ? (
        <DiscoveryNotice
          locale={locale}
          message={m.knowledge_discovery_preparing({}, options)}
          action={onContinue}
          actionLabel={m.knowledge_discovery_continue({}, options)}
          busy={snapshot.busy}
        />
      ) : null}
      {empty ? (
        <p role="status" className="text-sm text-muted-foreground">
          {m.knowledge_discovery_empty({}, options)}
        </p>
      ) : null}
      {sparse ? (
        <p role="status" className="text-sm text-muted-foreground">
          {m.knowledge_discovery_sparse({}, options)}
        </p>
      ) : null}
      {documents.length > 0 ? (
        <ul className="min-w-0 space-y-1">
          {documents.map((document) => (
            <DiscoveryRow
              key={`${document.documentId}:${document.revisionId}:${document.publicationId}`}
              locale={locale}
              document={document}
              returnTo={returnTo}
            />
          ))}
        </ul>
      ) : null}
      {next ? (
        <Button
          ref={moreRef}
          type="button"
          variant="outline"
          className={controlClass}
          disabled={snapshot.busy}
          onClick={onMore}
        >
          {snapshot.busy ? m.knowledge_discovery_preparing({}, options) : m.knowledge_discovery_more({}, options)}
        </Button>
      ) : null}
      {exhausted && documents.length > 0 ? (
        <p
          ref={endRef}
          tabIndex={-1}
          role="status"
          className="text-sm text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {m.knowledge_discovery_end({}, options)}
        </p>
      ) : null}
    </section>
  );
}

export type KnowledgeDiscoverySlotProps = {
  subjectId: string;
  locale: string;
  visitHref: string;
};

type KnowledgeDiscoveryReader = ConstructorParameters<typeof KnowledgeDiscoveryReading>[0];

export function KnowledgeDiscoveryCaller({
  binding,
  returnTo,
  read,
  current,
}: {
  binding: KnowledgeDiscoveryBinding;
  returnTo: string;
  read: KnowledgeDiscoveryReader;
  current: () => boolean;
}) {
  const live = useRef(current);
  live.current = current;
  const readRef = useRef(read);
  readRef.current = read;
  const [reading, setReading] = useState<KnowledgeDiscoveryReading | null>(null);
  const subscribe = reading?.subscribe ?? ignoreSubscribe;
  const snapshot = useSyncExternalStore(
    subscribe,
    () => reading?.getSnapshot() ?? idleSnapshot,
    () => reading?.getSnapshot() ?? idleSnapshot,
  );
  useLayoutEffect(() => {
    const instance = new KnowledgeDiscoveryReading(
      async (request) => {
        if (!live.current()) return { state: 'unavailable', status: 503 };
        const result = await readRef.current(request);
        if (!live.current()) return { state: 'unavailable', status: 503 };
        return result;
      },
      binding,
      () => live.current(),
    );
    setReading(instance);
    void instance.open(null);
    return () => {
      instance.retire();
      setReading((currentReading) => (currentReading === instance ? null : currentReading));
    };
  }, [binding.subjectId, binding.locale, binding.visitHref, binding.sessionRevision]);
  const actions = reading?.actions(snapshot);
  return (
    <KnowledgeDiscoveryPanel
      locale={binding.locale}
      returnTo={returnTo}
      snapshot={snapshot}
      onMore={actions?.more}
      onContinue={actions?.continuePreparation}
      onRetry={actions?.retry}
      onRestart={actions?.restart}
    />
  );
}

/** Default mount for a readable Subject. Missing discovery stays in this region. */
export function KnowledgeDiscoverySlot({ subjectId, locale, visitHref }: KnowledgeDiscoverySlotProps) {
  const queryClient = useQueryClient();
  const session = useSession();
  const source = readerSessionSource(queryClient);
  const sessionRevision = useSyncExternalStore(source.subscribe, source.snapshot, source.serverSnapshot);
  const csrfToken = session.state === 'signed-in' ? session.csrfToken : null;
  const returnTo = parseKnowledgeDiscoveryReturn(visitHref, locale, subjectId) ?? '';
  const binding: KnowledgeDiscoveryBinding = {
    subjectId,
    locale,
    visitHref: returnTo,
    sessionRevision,
  };
  const current = () => source.snapshot() === sessionRevision && getLocale() === locale && !retiredVisit.current;
  const retiredVisit = useRef(false);
  useLayoutEffect(() => {
    retiredVisit.current = false;
    const stop = source.subscribe(() => {
      if (source.snapshot() !== sessionRevision) retiredVisit.current = true;
    });
    return () => {
      retiredVisit.current = true;
      stop();
    };
  }, [source, sessionRevision, subjectId, locale, returnTo]);
  return (
    <KnowledgeDiscoveryCaller
      key={`${subjectId}:${locale}:${returnTo}:${sessionRevision}`}
      binding={binding}
      returnTo={returnTo}
      current={current}
      read={(request) =>
        readKnowledgeDiscoveryPage({
          data: request,
          ...(csrfToken ? { headers: { 'X-CSRF-Token': csrfToken } } : {}),
        })
      }
    />
  );
}
