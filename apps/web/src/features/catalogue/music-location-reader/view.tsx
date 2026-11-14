import { useId, useRef } from 'react';
import { ContentItemFrame } from '@rezics/ui/content-item';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import type { SubjectRead } from '@rezics/client';
import { m } from '../../../paraglide/messages.js';
import { subjectHref } from '../../../subject/subject-href';
import { ReadingValue } from './reading/value';
import { contextHref } from '../../pages/context-navigation';
import { useSubjectCommunityReading } from '../../pages/subject-community-lifetime';
import { linkClass, linkColor } from '../../pages/shared';
import type { MusicLocationRead, MusicLocationTransport } from './model';
import { musicLocationSnapshot } from './model';
import { useMusicLocationReading } from './reading/use-reading';
import { useEndpointReturn } from './reading/focus';

const action =
  'inline-flex min-h-11 min-w-11 max-w-full items-center whitespace-normal [overflow-wrap:anywhere] rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
const link = `${action} ${linkClass} ${linkColor} underline`;
type Ready = Extract<MusicLocationRead, { ok: true }>;

export type MusicLocationReaderProps = {
  subject: SubjectRead;
  context: string;
  source: object | string;
  reader: string | null;
  locale: string;
  realm?: string | undefined;
  transport: MusicLocationTransport;
  initial?: MusicLocationRead | undefined;
  refresh?: ((stream?: string) => Promise<void>) | undefined;
  restoreStream?: string | undefined;
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
  const snapshot = musicLocationSnapshot(props.subject.subject, props.context);
  const reading = useSubjectCommunityReading({
    source: props.source,
    reader: props.reader,
    descriptor: JSON.stringify([snapshot, props.locale, props.realm]),
  });
  const options = { locale: props.locale as never };
  return (
    <section data-slot="music-location-reader" aria-labelledby={headingId} className="min-w-0 space-y-4">
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

/** The native reader owns admission; this window only records explicit navigation intent. */
export function MusicLocationWindow({
  subject,
  context,
  locale,
  realm,
  transport,
  initial,
  current,
  focusHeading,
  refresh,
  restoreStream,
}: Omit<MusicLocationReaderProps, 'source' | 'reader'> & { current: () => boolean; focusHeading: () => void }) {
  const options = { locale: locale as never };
  const reading = useMusicLocationReading({
    snapshot: musicLocationSnapshot(subject.subject, context),
    initial,
    transport,
    current,
    refresh,
    restoreStream,
  });
  const { navigation, selected, requested, failure, busy, refreshing } = reading;
  const accepted = navigation.accepted;
  const page = accepted?.page;
  const returnFocus = useEndpointReturn({ accepted, current, heading: focusHeading });
  const selectedDescriptor = page?.streams.find((stream) => stream.key === selected);
  const retained = !!page && !!requested;
  const streamRequest = requested?.intent === 'open' || requested?.intent === 'stream';
  const continuationRequest = !!requested && !streamRequest;
  const disabled = busy || refreshing;
  const failureText = () => {
    switch (failure?.reason) {
      case 'stale':
        return m.music_location_changed({}, options);
      case 'denied':
        return m.music_context_denied({}, options);
      case 'withheld':
        return m.music_location_withheld({}, options);
      case 'invalid':
        return m.music_location_invalid({}, options);
      default:
        return m.music_location_unavailable({}, options);
    }
  };
  return (
    <div className="min-w-0 space-y-4 [overflow-wrap:anywhere]" aria-busy={disabled}>
      <div className="min-w-0 space-y-3 rounded-lg border border-border p-4 sm:p-5">
        {selectedDescriptor ? (
          <p data-slot="music-location-selected" className="min-w-0">
            <span className="font-medium">{m.music_location_selected({}, options)}</span>{' '}
            <span lang={selectedDescriptor.label.lang ?? undefined}>{selectedDescriptor.label.text}</span>
          </p>
        ) : null}
        {page && page.streams.length > 0 ? (
          <nav className="flex min-w-0 flex-wrap gap-2" aria-label={m.subject_relations({}, options)}>
            {page.streams.map((stream) => (
              <button
                key={stream.key}
                type="button"
                aria-pressed={stream.key === selected}
                disabled={disabled || (stream.key === selected && !failure)}
                className={`${buttonVariants({ variant: 'outline' })} ${action}`}
                onClick={() => void reading.select(stream.key)}
              >
                <span lang={stream.label.lang ?? undefined}>{stream.label.text}</span>
              </button>
            ))}
          </nav>
        ) : null}
        <div aria-live="polite" aria-atomic="true" className="space-y-2">
          {streamRequest && busy ? <p role="status">{m.music_context_loading({}, options)}</p> : null}
          {requested && streamRequest ? (
            <p role="status">
              {requested.address.cursor
                ? m.music_location_requested_continuation({}, options)
                : m.music_location_requested_start({}, options)}
            </p>
          ) : null}
          {reading.restoredUnavailable ? <p>{m.music_location_stream_removed({}, options)}</p> : null}
        </div>
      </div>
      {page ? (
        <section
          className="min-w-0 space-y-4 rounded-lg border border-border p-4 sm:p-5"
          aria-label={retained ? m.music_location_retained({}, options) : m.music_location_accepted({}, options)}
        >
          <header className="min-w-0 space-y-2">
            <p role="status" className="font-medium" data-slot="music-location-accepted">
              {retained ? m.music_location_retained({}, options) : m.music_location_accepted({}, options)}
            </p>
            <p className="text-lg font-semibold">
              <span>{kindLabel(page.kind, locale)}</span>
              {page.identity.typeLabel.text ? (
                <span lang={page.identity.typeLabel.lang ?? undefined}> · {page.identity.typeLabel.text}</span>
              ) : null}
            </p>
            {page.stream ? (
              <p className="text-base font-medium" lang={page.stream.label.lang ?? undefined}>
                {page.stream.label.text}
              </p>
            ) : null}
            {retained ? (
              <p className="text-sm text-muted-foreground">{m.music_location_retained_help({}, options)}</p>
            ) : null}
          </header>
          {page.kind === 'unsupported' ? <p role="status">{m.music_location_unsupported({}, options)}</p> : null}
          {page.stream ? (
            <>
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
              {!page.rows.length ? <p role="status">{m.music_location_empty({}, options)}</p> : null}
              <ul className="min-w-0 space-y-3 sm:space-y-4">
                {page.rows.map((row) => {
                  const summary = row.summary;
                  const type = summary ? page.types[summary.type] : undefined;
                  const href = summary
                    ? contextHref(
                        subjectHref({ id: summary.id, label: summary.label?.value ?? '' }, locale).href,
                        realm,
                      )
                    : undefined;
                  return (
                    <li key={`${row.holder}:${row.statementId}`} data-slot="music-location-row" className="min-w-0">
                      <ContentItemFrame
                        as="div"
                        className="min-w-0 space-y-4 rounded-lg border border-border bg-card p-4 [overflow-wrap:anywhere] sm:p-5"
                      >
                        <header className="min-w-0 space-y-2">
                          <h3 className="text-base font-semibold" lang={summary?.label?.language}>
                            {summary?.label?.value || m.work_parts_unresolved({}, options)}
                          </h3>
                        </header>
                        {summary && href ? (
                          <div className="flex min-w-0 flex-col items-start gap-2 sm:flex-row sm:items-center sm:gap-4">
                            <p className="min-w-0 text-sm text-muted-foreground">
                              <span>{m.album_tracks_kind({}, options)}: </span>
                              <span lang={type?.lang ?? undefined}>{type?.text || summary.type}</span>
                            </p>
                            <a
                              className={link}
                              href={href}
                              target="_blank"
                              rel="noopener"
                              data-occurrence={`${row.holder}:${row.statementId}`}
                              onClick={returnFocus}
                            >
                              {m.album_tracks_open({}, options)}
                            </a>
                          </div>
                        ) : null}
                        {row.statement?.qualifiers.length ? (
                          <div className="min-w-0 rounded-md bg-muted/40 p-3 sm:p-4">
                            <dl className="grid min-w-0 gap-x-4 gap-y-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
                              {row.statement.qualifiers.map((snak, index) => (
                                <div key={index} className="min-w-0">
                                  <dt
                                    className="text-sm font-medium text-muted-foreground"
                                    lang={page.labels[snak.property.id]?.lang ?? undefined}
                                  >
                                    {page.labels[snak.property.id]?.text || snak.property.id}
                                  </dt>
                                  <dd className="min-w-0 pt-1">
                                    <ReadingValue snak={snak} related={row.related} locale={locale} />
                                  </dd>
                                </div>
                              ))}
                            </dl>
                          </div>
                        ) : !row.statement ? (
                          <p role="status" className="rounded-md bg-muted/40 p-3 sm:p-4">
                            {m.work_parts_assertion_unavailable({}, options)}
                          </p>
                        ) : null}
                        <details className="min-w-0 rounded-lg border border-border p-3">
                          <summary className={`${action} cursor-pointer font-medium`}>
                            {m.sources_citations({}, options)}
                          </summary>
                          {row.statement?.references.length ? (
                            row.statement.references.map((reference, index) => (
                              <dl key={index} className="mt-3 space-y-2">
                                {reference.parts.map((snak, part) => (
                                  <div key={part}>
                                    <dt lang={page.labels[snak.property.id]?.lang ?? undefined}>
                                      {page.labels[snak.property.id]?.text || snak.property.id}
                                    </dt>
                                    <dd>
                                      <ReadingValue snak={snak} related={row.related} locale={locale} />
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
            </>
          ) : null}
        </section>
      ) : null}
      {page?.stream ? (
        <section className="min-w-0 space-y-3 border-t border-border pt-4">
          <nav className="flex min-w-0 flex-wrap gap-2" aria-label={m.music_location_navigation({}, options)}>
            <button
              type="button"
              className={`${buttonVariants({ variant: 'outline' })} ${action}`}
              disabled={disabled || !reading.previous || !!failure || selected !== page.stream.key}
              onClick={() => void reading.back()}
            >
              {m.music_location_previous({}, options)}
            </button>
            <button
              type="button"
              className={`${buttonVariants({ variant: 'outline' })} ${action}`}
              disabled={disabled || !selected}
              onClick={() => void reading.start()}
            >
              {m.music_location_start({}, options)}
            </button>
            {page.next && selected === page.stream.key ? (
              <button
                type="button"
                className={`${buttonVariants({ variant: 'outline' })} ${action}`}
                disabled={disabled || !!failure}
                onClick={() => void reading.more()}
              >
                {m.work_parts_more({}, options)}
              </button>
            ) : null}
          </nav>
          <div aria-live="polite" aria-atomic="true" className="space-y-2">
            {continuationRequest && busy ? <p role="status">{m.music_context_loading({}, options)}</p> : null}
            {requested && continuationRequest ? (
              <p role="status">
                {requested.address.cursor
                  ? m.music_location_requested_continuation({}, options)
                  : m.music_location_requested_start({}, options)}
              </p>
            ) : null}
          </div>
          {page && navigation.evicted && !reading.previous ? <p>{m.music_location_boundary({}, options)}</p> : null}
        </section>
      ) : null}
      {failure || reading.refreshing || reading.refreshFailed ? (
        <section className="min-w-0 space-y-3 rounded-lg border border-border p-4 sm:p-5">
          {reading.refreshing ? (
            <div aria-live="polite" aria-atomic="true">
              <p role="status">{m.music_location_refreshing({}, options)}</p>
            </div>
          ) : null}
          {failure ? (
            <div role="alert" className="space-y-2">
              <p>{failureText()}</p>
              {failure.reason === 'unavailable' ? (
                <button
                  type="button"
                  className={`${buttonVariants({ variant: 'outline' })} ${action}`}
                  disabled={disabled}
                  onClick={() => void reading.retry()}
                >
                  {m.music_location_retry({}, options)}
                </button>
              ) : null}
              {failure.reason === 'stale' && refresh ? (
                <button
                  type="button"
                  className={`${buttonVariants({ variant: 'outline' })} ${action}`}
                  disabled={disabled}
                  onClick={() => void reading.refresh()}
                >
                  {m.music_location_refresh({}, options)}
                </button>
              ) : null}
              {failure.reason === 'invalid' ? (
                <button
                  type="button"
                  className={`${buttonVariants({ variant: 'outline' })} ${action}`}
                  disabled={disabled}
                  onClick={() => void reading.choices()}
                >
                  {m.music_location_choices({}, options)}
                </button>
              ) : null}
            </div>
          ) : null}
          {reading.refreshFailed ? <p role="alert">{m.music_location_refresh_failed({}, options)}</p> : null}
        </section>
      ) : null}
    </div>
  );
}
