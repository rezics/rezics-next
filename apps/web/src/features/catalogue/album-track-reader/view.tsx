import { useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../../../paraglide/messages.js';
import { subjectHref } from '../../../subject/subject-href';
import { CandidateValue } from '../../pages/data';
import { contextHref } from '../../pages/context-navigation';
import { useSubjectCommunityReading } from '../../pages/subject-community-lifetime';
import { linkClass, linkColor } from '../../pages/shared';
import type { AlbumTrackAddress, AlbumTrackRead, AlbumTrackTransport } from './model';

const action =
  'inline-flex min-h-11 min-w-11 max-w-full items-center whitespace-normal [overflow-wrap:anywhere] rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
const link = `${action} ${linkClass} ${linkColor} underline`;
type Ready = Extract<AlbumTrackRead, { ok: true }>;
type Failure = Extract<AlbumTrackRead, { ok: false }>;
type Props = {
  id: string;
  context: string;
  locale: string;
  realm?: string | undefined;
  transport: AlbumTrackTransport;
  source: object | string;
  reader: string | null;
  initial?: AlbumTrackRead;
};

/** Observe existing viewer/disclosure caches; a retired source never revives after an away/back transition. */
export function AlbumTrackReader(props: Props) {
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const focused = useRef<EventTarget | null>(null);
  const reading = useSubjectCommunityReading({
    source: props.source,
    reader: props.reader,
    descriptor: JSON.stringify([props.id, props.context, props.locale, props.realm]),
  });
  useLayoutEffect(() => {
    if (focused.current instanceof Element && !focused.current.isConnected && document.activeElement === document.body)
      heading.current?.focus();
  }, [reading.key, reading.available]);
  const o = { locale: props.locale as never };
  return (
    <section
      data-slot="album-track-reader"
      aria-labelledby={headingId}
      className="min-w-0 space-y-4"
      onFocusCapture={(event) => {
        focused.current = event.target;
      }}
    >
      <ContentItemHeading id={headingId} ref={heading} tabIndex={-1} level={2} className="text-xl font-semibold">
        {m.album_tracks_title({}, o)}
      </ContentItemHeading>
      {reading.available ? (
        <AlbumTrackWindow
          key={reading.key}
          {...props}
          current={reading.isCurrent}
          focusHeading={() => heading.current?.focus()}
        />
      ) : (
        <p role="status">{m.album_tracks_unavailable({}, o)}</p>
      )}
    </section>
  );
}

/** Keep one accepted window and one exact pending address. Failed continuation never refills or changes stream. */
export function AlbumTrackWindow({
  id,
  context,
  locale,
  realm,
  transport,
  initial,
  current,
  focusHeading,
}: Omit<Props, 'source' | 'reader'> & { current: () => boolean; focusHeading: () => void }) {
  const o = { locale: locale as never };
  const [page, setPage] = useState<Ready | undefined>(initial?.ok ? initial : undefined);
  const [failure, setFailure] = useState<Failure | undefined>(initial && !initial.ok ? initial : undefined);
  const [busy, setBusy] = useState(!initial);
  const mounted = useRef(false);
  const sequence = useRef(0);
  const inFlight = useRef(false);
  const pending = useRef<AlbumTrackAddress>({ id, context });
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
  const read = async (address: AlbumTrackAddress, trigger?: HTMLButtonElement, keyboard = false) => {
    if (!mounted.current || !current() || inFlight.current) return;
    inFlight.current = true;
    const turn = ++sequence.current;
    pending.current = address;
    setBusy(true);
    setFailure(undefined);
    let result: AlbumTrackRead;
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
      if (keyboard && trigger === document.activeElement) focusHeading();
    } else {
      setFailure(result);
      if (result.reason !== 'unavailable') setPage(undefined);
    }
  };
  useEffect(() => {
    mounted.current = true;
    if (!initial) void read({ id, context });
    return () => {
      mounted.current = false;
      sequence.current++;
      origin.current = null;
    };
    // The parent remounts this window for every source, address, viewer or locale observation.
  }, []);
  const request = (address: AlbumTrackAddress) => (event: MouseEvent<HTMLButtonElement>) => {
    if (!busy) void read(address, event.currentTarget, event.detail === 0);
  };
  const base = { id, context };
  return (
    <div className="min-w-0 space-y-4" aria-busy={busy}>
      <p className="text-sm text-muted-foreground">{m.album_tracks_scope({}, o)}</p>
      <p className="text-sm text-muted-foreground">{m.album_tracks_return({}, o)}</p>
      {busy ? <p role="status">{m.candidate_loading({}, o)}</p> : null}
      {failure ? (
        <div role="alert" className="space-y-2">
          <p>
            {failure.reason === 'withheld'
              ? m.album_tracks_withheld({}, o)
              : page
                ? m.album_tracks_next_unavailable({}, o)
                : m.album_tracks_unavailable({}, o)}
          </p>
          <button
            type="button"
            className={`${buttonVariants({ variant: 'outline' })} ${action}`}
            disabled={busy}
            onClick={request(pending.current)}
          >
            {m.album_tracks_retry({}, o)}
          </button>
        </div>
      ) : null}
      {page && !page.stream ? <p role="status">{m.album_tracks_unconfigured({}, o)}</p> : null}
      {page && page.stream ? (
        <>
          <nav className="flex min-w-0 flex-wrap gap-2" aria-label={m.work_parts_relation({}, o)}>
            {page.streams.map((stream) => (
              <button
                key={stream.key}
                type="button"
                aria-pressed={stream.key === page.stream?.key}
                disabled={busy}
                className={`${buttonVariants({ variant: 'outline' })} ${action}`}
                onClick={request({ ...base, stream: stream.key })}
              >
                <span lang={stream.label.lang ?? undefined}>{stream.label.text || stream.property}</span>
              </button>
            ))}
          </nav>
          <p className="text-sm text-muted-foreground">{m.work_parts_slice({}, o)}</p>
          {!page.caughtUp ? <p role="status">{m.work_parts_pending({}, o)}</p> : null}
          {page.count ? (
            <p>
              {m.work_parts_count(
                {
                  accuracy: page.count.exact ? m.work_parts_exact({}, o) : m.work_parts_at_least({}, o),
                  count: page.count.value,
                },
                o,
              )}
            </p>
          ) : null}
          {!page.rows.length ? <p role="status">{m.work_parts_empty({}, o)}</p> : null}
          <ul className="min-w-0 divide-y divide-border">
            {page.rows.map((row) => {
              const summary = row.summary;
              const type = summary ? page.types[summary.type] : undefined;
              const href = summary
                ? contextHref(subjectHref({ id: summary.id, label: summary.label?.value ?? '' }, locale).href, realm)
                : undefined;
              const holder = contextHref(
                subjectHref(
                  { id: row.holder, label: row.holder === id ? page.album.label.text : (summary?.label?.value ?? '') },
                  locale,
                ).href,
                realm,
              );
              return (
                <li key={`${row.holder}:${row.statementId}`} data-slot="album-track-row" className="min-w-0">
                  <ContentItemFrame as="div" className="min-w-0 space-y-3 py-4 [overflow-wrap:anywhere]">
                    <h3 className="font-semibold" lang={summary?.label?.language}>
                      {summary?.label?.value || m.work_parts_unresolved({}, o)}
                    </h3>
                    {summary && href ? (
                      <>
                        <p className="text-sm">
                          <span>{m.album_tracks_kind({}, o)}: </span>
                          <span lang={type?.lang ?? undefined}>{type?.text || summary.type}</span>
                        </p>
                        <a className={link} href={href} target="_blank" rel="noopener" onClick={returnFocus}>
                          {m.album_tracks_open({}, o)}
                        </a>
                      </>
                    ) : null}
                    {row.statement ? (
                      <>
                        {row.statement.value.type !== 'value' ? (
                          <CandidateValue snak={row.statement} related={row.related} locale={locale} />
                        ) : null}
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
                        <details className="min-w-0 rounded-lg border border-border p-3">
                          <summary className={`${action} cursor-pointer`}>{m.sources_citations({}, o)}</summary>
                          {row.statement.references.length ? (
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
                            <p>{m.music_reader_source_unavailable({}, o)}</p>
                          )}
                        </details>
                      </>
                    ) : (
                      <p>{m.work_parts_assertion_unavailable({}, o)}</p>
                    )}
                    <details className="min-w-0 rounded-lg border border-border p-3">
                      <summary className={`${action} cursor-pointer`}>{m.catalogue_technical_details({}, o)}</summary>
                      <dl className="mt-3 space-y-2 text-sm [overflow-wrap:anywhere]">
                        <div>
                          <dt>{m.work_parts_holder({}, o)}</dt>
                          <dd>{row.holder}</dd>
                        </div>
                        <div>
                          <dt>{m.album_tracks_membership({}, o)}</dt>
                          <dd>{row.statementId}</dd>
                        </div>
                        {summary ? (
                          <div>
                            <dt>{m.album_tracks_target({}, o)}</dt>
                            <dd>{summary.id}</dd>
                          </div>
                        ) : null}
                        <div>
                          <dt>{m.work_parts_relation({}, o)}</dt>
                          <dd>{page.stream?.property}</dd>
                        </div>
                      </dl>
                    </details>
                    <a
                      className={link}
                      href={contextHref(`${holder.split('?')[0]}/relation-edit`, realm)}
                      target="_blank"
                      rel="noopener"
                      onClick={returnFocus}
                    >
                      {m.album_tracks_correction({}, o)}
                    </a>
                  </ContentItemFrame>
                </li>
              );
            })}
          </ul>
          <div className="flex flex-wrap gap-3">
            {page.next ? (
              <button
                type="button"
                disabled={busy}
                className={`${buttonVariants({ variant: 'outline' })} ${action}`}
                onClick={request({ ...base, stream: page.stream.key, cursor: page.next })}
              >
                {m.work_parts_more({}, o)}
              </button>
            ) : (
              <p role="status">{m.album_tracks_complete({}, o)}</p>
            )}
            <button
              type="button"
              disabled={busy}
              className={`${buttonVariants({ variant: 'outline' })} ${action}`}
              onClick={request({ ...base, stream: page.stream.key })}
            >
              {m.work_parts_restart({}, o)}
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
