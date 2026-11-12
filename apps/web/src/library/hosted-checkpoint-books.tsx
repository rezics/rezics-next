import { useLayoutEffect, useMemo, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import type { Locale } from '../paraglide/runtime.js';
import { useLibraryApplication, useSession } from './application';
import { SectionHeading } from './section-heading';
import { readLibraryHostedCheckpoints } from './hosted-checkpoint-read';
import { hostedCheckpointHref, type HostedCheckpointHref, type HostedCheckpointRead } from './hosted-checkpoint-source';
import { HostedCheckpointWindow, type HostedCheckpointWindowSnapshot } from './hosted-checkpoint-window';

const read: HostedCheckpointRead = (data, signal) => readLibraryHostedCheckpoints({ data, signal });
type Props = { locale: Locale; bookHref: HostedCheckpointHref };

/** Mounted alongside Entry progress, with no shared address or cursor state. */
export function HostedCheckpointBooks(props: Props) {
  const session = useSession();
  if (session.state !== 'signed-in' || !session.subject) {
    const state = session.state === 'signed-out' ? 'signed-out' : session.state === 'unknown' ? 'loading' : 'unavailable';
    return <HostedCheckpointBooksView {...props} snapshot={{
      result: { state }, busy: state === 'loading', cursor: null, previous: false, first: false,
    }} />;
  }
  return <CurrentHostedCheckpointBooks {...props} />;
}

function CurrentHostedCheckpointBooks(props: Props) {
  const application = useLibraryApplication();
  const client = useQueryClient();
  const observer = useMemo(() => application.recoveryObservation(client), [application, client]);
  const controller = useMemo(() => new HostedCheckpointWindow(observer, props.locale, read), [observer, props.locale]);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getServerSnapshot);
  useLayoutEffect(() => controller.start(), [controller]);
  return <HostedCheckpointBooksView {...props} snapshot={snapshot} actions={{
    next: () => controller.next(snapshot),
    previous: () => controller.previous(snapshot),
    first: () => controller.first(snapshot),
    retry: () => controller.retry(snapshot),
    refresh: () => controller.refresh(snapshot),
  }} />;
}

type Actions = { next: () => void; previous: () => void; first: () => void; retry: () => void; refresh: () => void };

/** Titles come only from the native available metadata branch; withheld rows have no link operands. */
export function HostedCheckpointBooksView({
  locale, bookHref, snapshot, actions,
}: Props & { snapshot: HostedCheckpointWindowSnapshot; actions?: Actions }) {
  const options = { locale };
  const { result } = snapshot;
  const message = result.state === 'loading' ? m.library_hosted_loading({}, options)
    : result.state === 'signed-out' ? m.library_hosted_signed_out({}, options)
    : result.state === 'denied' ? m.library_hosted_denied({}, options)
    : result.state === 'stale' ? m.library_hosted_stale({}, options)
    : result.state === 'unavailable' ? m.library_hosted_unavailable({}, options)
    : result.items.length === 0 ? (snapshot.cursor === null ? m.library_hosted_empty({}, options) : m.library_hosted_empty_page({}, options))
    : null;
  const recoverable = result.state === 'loaded' || result.state === 'unavailable' || result.state === 'stale';
  return (
    <section aria-labelledby="library-hosted-books" aria-busy={snapshot.busy} className="space-y-4">
      <SectionHeading id="library-hosted-books">{m.library_hosted_title({}, options)}</SectionHeading>
      <p className="max-w-prose text-sm text-muted-foreground">{m.library_hosted_help({}, options)}</p>
      <div aria-live="polite" aria-atomic="true">
        {message ? <p className="text-sm text-muted-foreground">{message}</p> : null}
      </div>
      {result.state === 'loaded' && result.items.length > 0 ? (
        <ul className="divide-y divide-border">
          {result.items.map((item, index) => (
            <li key={`${item.subjectId}:${item.revision}:${index}`} className="py-3 first:pt-0 last:pb-0">
              {item.availability === 'available' ? (
                <a href={hostedCheckpointHref(item, locale, bookHref)} className="inline-block max-w-full rounded-sm font-medium break-words text-foreground underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
                  {item.title}
                </a>
              ) : <p className="text-sm text-muted-foreground">{m.book_reader_checkpoint_withheld({}, options)}</p>}
            </li>
          ))}
        </ul>
      ) : null}
      {actions && recoverable ? (
        <nav aria-label={m.library_hosted_title({}, options)} className="flex flex-wrap gap-2">
          {snapshot.previous ? <Button variant="outline" size="sm" disabled={snapshot.busy} onClick={actions.previous}>{m.library_continue_previous_window({}, options)}</Button> : null}
          {result.state === 'loaded' && result.nextCursor !== null ? <Button variant="outline" size="sm" disabled={snapshot.busy} onClick={actions.next}>{m.library_next_page({}, options)}</Button> : null}
          {snapshot.first ? <Button variant="outline" size="sm" disabled={snapshot.busy} onClick={actions.first}>{m.library_continue_address_newest({}, options)}</Button> : null}
          {result.state === 'unavailable' ? <Button variant="outline" size="sm" disabled={snapshot.busy} onClick={actions.retry}>{m.library_hosted_retry({}, options)}</Button> : null}
          {result.state === 'loaded' ? <Button variant="ghost" size="sm" disabled={snapshot.busy} onClick={actions.refresh}>{m.library_hosted_refresh({}, options)}</Button> : null}
        </nav>
      ) : null}
    </section>
  );
}
