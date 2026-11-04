import { useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { ContentItemFrame } from '@rezics/ui/content-item';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import type { SubjectRead } from '@rezics/client';
import { m } from '../../../paraglide/messages.js';
import { subjectHref } from '../../../subject/subject-href';
import { CandidateValue } from '../../pages/data';
import { contextHref } from '../../pages/context-navigation';
import { useSubjectCommunityReading } from '../../pages/subject-community-lifetime';
import { linkClass, linkColor } from '../../pages/shared';
import type { MusicLocationAddress, MusicLocationRead, MusicLocationTransport } from './model';
import { musicLocationSnapshot } from './model';

const action =
  'inline-flex min-h-11 min-w-11 max-w-full items-center whitespace-normal [overflow-wrap:anywhere] rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
const link = `${action} ${linkClass} ${linkColor} underline`;
type Ready = Extract<MusicLocationRead, { ok: true }>;
type Failure = Extract<MusicLocationRead, { ok: false }>;

export type MusicLocationReaderProps = {
  subject: SubjectRead;
  context: string;
  source: object | string;
  reader: string | null;
  locale: string;
  realm?: string | undefined;
  transport: MusicLocationTransport;
  initial?: MusicLocationRead | undefined;
};

function kindLabel(kind: Ready['kind'], locale: string) {
  const options = { locale: locale as never };
  if (kind === 'place') return m.music_context_place({}, options);
  if (kind === 'event') return m.music_context_event({}, options);
  if (kind === 'area') return m.music_context_area({}, options);
  if (kind === 'instrument') return m.music_context_instrument({}, options);
  return m.music_location_unsupported({}, options);
}

/** Read the exact current Subject's admitted music-context relationships in its ordinary overview. */
export function MusicLocationReader(props: MusicLocationReaderProps) {
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const focused = useRef<EventTarget | null>(null);
  const snapshot = musicLocationSnapshot(props.subject.subject, props.context);
  const reading = useSubjectCommunityReading({
    source: props.source,
    reader: props.reader,
    descriptor: JSON.stringify([snapshot, props.locale, props.realm]),
  });
  useLayoutEffect(() => {
    if (focused.current instanceof Element && !focused.current.isConnected && document.activeElement === document.body)
      heading.current?.focus();
  }, [reading.key, reading.available]);
  const options = { locale: props.locale as never };
  return (
    <section
      data-slot="music-location-reader"
      aria-labelledby={headingId}
      className="min-w-0 space-y-4"
      onFocusCapture={(event) => {
        focused.current = event.target;
      }}
    >
      <h2 id={headingId} ref={heading} tabIndex={-1} className="text-xl font-semibold">
        {m.music_context_title({}, options)}
      </h2>
      <p className="max-w-prose text-muted-foreground">{m.music_context_intro({}, options)}</p>
      {reading.available ? (
        <MusicLocationWindow
          key={reading.key}
          {...props}
          current={reading.isCurrent}
          focusHeading={() => heading.current?.focus()}
        />
      ) : (
        <p role="status">{m.music_context_unavailable({}, options)}</p>
      )}
    </section>
  );
}

/** Keep one accepted relation window and one exact pending address. */
export function MusicLocationWindow({
  subject,
  context,
  locale,
  realm,
  transport,
  initial,
  current,
  focusHeading,
}: Omit<MusicLocationReaderProps, 'source' | 'reader'> & { current: () => boolean; focusHeading: () => void }) {
  const options = { locale: locale as never };
  const snapshot = musicLocationSnapshot(subject.subject, context);
  const [page, setPage] = useState<Ready | undefined>(initial?.ok ? initial : undefined);
  const [failure, setFailure] = useState<Failure | undefined>(initial && !initial.ok ? initial : undefined);
  const [busy, setBusy] = useState(!initial);
  const mounted = useRef(false);
  const sequence = useRef(0);
  const inFlight = useRef(false);
  const pending = useRef<MusicLocationAddress>(snapshot);
  const origin = useRef<HTMLAnchorElement | null>(null);
  const returnFocus = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.detail === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey) origin.current = event.currentTarget;
  };

  useEffect(() => {
    const restore = () => {
      const target = origin.current;
      origin.current = null;
      if (!current() || !target) return;
      if (target.isConnected && (document.activeElement === target || document.activeElement === document.body))
        target.focus();
      else if (!target.isConnected && document.activeElement === document.body) focusHeading();
    };
    window.addEventListener('focus', restore);
    return () => window.removeEventListener('focus', restore);
  }, [current, focusHeading]);

  const read = async (address: MusicLocationAddress, trigger?: HTMLButtonElement, keyboard = false) => {
    if (!mounted.current || !current() || inFlight.current) return;
    inFlight.current = true;
    const turn = ++sequence.current;
    pending.current = address;
    setBusy(true);
    setFailure(undefined);
    let result: MusicLocationRead;
    try {
      result = await transport(address);
    } catch {
      result = { ok: false, reason: 'unavailable' };
    }
    if (!mounted.current || !current() || sequence.current !== turn) return;
    inFlight.current = false;
    setBusy(false);
    if (result.ok) {
      setPage(result);
      if (
        keyboard &&
        trigger &&
        (trigger === document.activeElement || (!trigger.isConnected && document.activeElement === document.body))
      )
        focusHeading();
    } else {
      setFailure(result);
      if (result.reason !== 'unavailable') setPage(undefined);
    }
  };

  useEffect(() => {
    mounted.current = true;
    if (!initial) void read(snapshot);
    return () => {
      mounted.current = false;
      inFlight.current = false;
      sequence.current++;
      origin.current = null;
    };
    // The parent remounts this window for each source, Subject, authority or locale observation.
  }, []);

  const request = (address: MusicLocationAddress) => (event: MouseEvent<HTMLButtonElement>) => {
    if (!busy) void read(address, event.currentTarget, event.detail === 0);
  };
  const address = { ...snapshot, ...(page?.session ? { session: page.session } : {}) };
  const failureText = (reason: Failure['reason']) =>
    reason === 'stale'
      ? m.subject_view_changed({}, options)
      : reason === 'denied'
        ? m.music_context_denied({}, options)
        : m.music_context_unavailable({}, options);

  return (
    <div className="min-w-0 space-y-4" aria-busy={busy}>
      {busy ? <p role="status">{m.music_context_loading({}, options)}</p> : null}
      {failure ? (
        <div role="alert" className="space-y-2">
          <p>{failureText(failure.reason)}</p>
          <button
            type="button"
            className={`${buttonVariants({ variant: 'outline' })} ${action}`}
            disabled={busy}
            onClick={request(pending.current)}
          >
            {m.subject_view_retry({}, options)}
          </button>
        </div>
      ) : null}
      {page ? (
        <>
          <p className="font-medium">
            <span>{kindLabel(page.kind, locale)}</span>
            {page.identity.typeLabel.text ? (
              <span lang={page.identity.typeLabel.lang ?? undefined}> · {page.identity.typeLabel.text}</span>
            ) : null}
          </p>
          {page.kind === 'unsupported' ? (
            <p role="status">{m.music_location_unsupported({}, options)}</p>
          ) : null}
          {page.stream ? (
            <>
              {page.streams.length > 1 ? (
                <nav className="flex min-w-0 flex-wrap gap-2" aria-label={m.subject_relations({}, options)}>
                  {page.streams.map((stream) => (
                    <button
                      key={stream.key}
                      type="button"
                      aria-pressed={stream.key === page.stream?.key}
                      disabled={busy}
                      className={`${buttonVariants({ variant: 'outline' })} ${action}`}
                      onClick={request({ ...address, stream: stream.key })}
                    >
                      <span lang={stream.label.lang ?? undefined}>{stream.label.text}</span>
                    </button>
                  ))}
                </nav>
              ) : null}
              {!page.caughtUp ? <p role="status">{m.work_parts_pending({}, options)}</p> : null}
              {page.count ? (
                <p>
                  {m.work_parts_count(
                    {
                      accuracy: page.count.exact ? m.work_parts_exact({}, options) : m.work_parts_at_least({}, options),
                      count: page.count.value,
                    },
                    options,
                  )}
                </p>
              ) : null}
              {!page.rows.length ? <p role="status">{m.work_parts_empty({}, options)}</p> : null}
              <ul className="min-w-0 divide-y divide-border">
                {page.rows.map((row) => {
                  const summary = row.summary;
                  const type = summary ? page.types[summary.type] : undefined;
                  const href = summary
                    ? contextHref(subjectHref({ id: summary.id, label: summary.label?.value ?? '' }, locale).href, realm)
                    : undefined;
                  return (
                    <li key={`${row.holder}:${row.statementId}`} data-slot="music-location-row" className="min-w-0">
                      <ContentItemFrame as="div" className="min-w-0 space-y-3 py-4 [overflow-wrap:anywhere]">
                        <p className="text-sm text-muted-foreground" lang={page.stream?.label.lang ?? undefined}>
                          {page.stream?.label.text}
                        </p>
                        <h3 className="font-semibold" lang={summary?.label?.language}>
                          {summary?.label?.value || m.work_parts_unresolved({}, options)}
                        </h3>
                        {summary && href ? (
                          <>
                            <p className="text-sm">
                              <span>{m.album_tracks_kind({}, options)}: </span>
                              <span lang={type?.lang ?? undefined}>{type?.text || summary.type}</span>
                            </p>
                            <a className={link} href={href} target="_blank" rel="noopener" onClick={returnFocus}>
                              {m.album_tracks_open({}, options)}
                            </a>
                          </>
                        ) : null}
                        {row.statement ? (
                          <dl className="space-y-2">
                            {row.statement.qualifiers.map((snak, index) => (
                              <div key={index}>
                                <dt
                                  className="text-sm text-muted-foreground"
                                  lang={page.labels[snak.property.id]?.lang ?? undefined}
                                >
                                  {page.labels[snak.property.id]?.text || snak.property.id}
                                </dt>
                                <dd>
                                  <CandidateValue snak={snak} related={row.related} locale={locale} />
                                </dd>
                              </div>
                            ))}
                          </dl>
                        ) : (
                          <p role="status">{m.work_parts_assertion_unavailable({}, options)}</p>
                        )}
                        <details className="min-w-0 rounded-lg border border-border p-3">
                          <summary className={`${action} cursor-pointer`}>{m.sources_citations({}, options)}</summary>
                          {row.statement?.references.length ? (
                            row.statement.references.map((reference, index) => (
                              <dl key={index} className="mt-3 space-y-2">
                                {reference.parts.map((snak, part) => (
                                  <div key={part}>
                                    <dt lang={page.labels[snak.property.id]?.lang ?? undefined}>
                                      {page.labels[snak.property.id]?.text || snak.property.id}
                                    </dt>
                                    <dd>
                                      <CandidateValue snak={snak} related={row.related} locale={locale} />
                                    </dd>
                                  </div>
                                ))}
                              </dl>
                            ))
                          ) : (
                            <p>{m.music_reader_source_unavailable({}, options)}</p>
                          )}
                        </details>
                      </ContentItemFrame>
                    </li>
                  );
                })}
              </ul>
              {page.next ? (
                <button
                  type="button"
                  className={`${buttonVariants({ variant: 'outline' })} ${action}`}
                  disabled={busy}
                  onClick={request({ ...address, stream: page.stream.key, cursor: page.next })}
                >
                  {m.work_parts_more({}, options)}
                </button>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
