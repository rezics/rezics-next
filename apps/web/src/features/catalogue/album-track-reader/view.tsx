import { useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { ContentItemFrame } from '@rezics/ui/content-item';
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
  const currentSubjectHref = contextHref(subjectHref({ id: props.id, label: '' }, props.locale).href, props.realm);
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
      <h2 id={headingId} ref={heading} tabIndex={-1} className="text-xl font-semibold">
        {m.album_tracks_title({}, o)}
      </h2>
      {reading.available ? (
        <AlbumTrackWindow
          key={reading.key}
          {...props}
          current={reading.isCurrent}
          focusHeading={() => heading.current?.focus()}
        />
      ) : (
        <div role="status" className="space-y-2">
          <p>{m.album_tracks_unavailable({}, o)}</p>
          <a className={link} href={currentSubjectHref}>
            {m.album_tracks_subject_recovery({}, o)}
          </a>
        </div>
      )}
    </section>
  );
}

/** Keep one accepted window, one exact pending address, and a bounded stack of addresses only. */
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
  const [streams, setStreams] = useState<Ready['streams']>(initial?.ok ? initial.streams : []);
  const [selectedStream, setSelectedStream] = useState<string | undefined>(initial?.ok ? initial.stream?.key : undefined);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [previousCount, setPreviousCount] = useState(0);
  const inspectionId = useId();
  const inspectionHeading = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(false);
  const sequence = useRef(0);
  const inFlight = useRef(false);
  const base = { id, context };
  const initialAddress: AlbumTrackAddress = {
    ...base,
    ...(initial?.ok && initial.stream ? { stream: initial.stream.key } : {}),
  };
  const acceptedAddress = useRef<AlbumTrackAddress>(initialAddress);
  const hasAcceptedAddress = useRef(!!initial?.ok);
  const priorAddresses = useRef<AlbumTrackAddress[]>([]);
  const pending = useRef<AlbumTrackAddress>(initialAddress);
  const pendingIsPrevious = useRef(false);
  const origin = useRef<HTMLAnchorElement | null>(null);
  const selectionOpener = useRef<HTMLButtonElement | null>(null);
  const keyboardSelection = useRef(false);
  const inspectionHeadingId = `${inspectionId}-heading`;

  const sameAddress = (left: AlbumTrackAddress, right: AlbumTrackAddress) =>
    left.id === right.id &&
    left.context === right.context &&
    left.stream === right.stream &&
    left.cursor === right.cursor;

  const committedAddress = (address: AlbumTrackAddress, result: Ready): AlbumTrackAddress => ({
    id: address.id,
    context: address.context,
    ...(result.stream ? { stream: result.stream.key } : address.stream ? { stream: address.stream } : {}),
    ...(address.cursor ? { cursor: address.cursor } : {}),
  });

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
  const read = async (
    address: AlbumTrackAddress,
    trigger?: HTMLButtonElement,
    keyboard = false,
    isPrevious = false,
  ) => {
    if (!mounted.current || !current() || inFlight.current) return;
    inFlight.current = true;
    const turn = ++sequence.current;
    pending.current = address;
    pendingIsPrevious.current = isPrevious;
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
      const nextAddress = committedAddress(address, result);
      if (isPrevious) {
        const last = priorAddresses.current.at(-1);
        if (last && sameAddress(last, address)) priorAddresses.current = priorAddresses.current.slice(0, -1);
      } else if (hasAcceptedAddress.current && !sameAddress(acceptedAddress.current, nextAddress)) {
        priorAddresses.current = [...priorAddresses.current, acceptedAddress.current].slice(-8);
      }
      acceptedAddress.current = nextAddress;
      hasAcceptedAddress.current = true;
      pending.current = nextAddress;
      pendingIsPrevious.current = false;
      setPreviousCount(priorAddresses.current.length);
      setStreams(result.streams);
      setSelectedStream(result.stream?.key);
      selectionOpener.current = null;
      keyboardSelection.current = false;
      origin.current = null;
      setSelectedKey(null);
      setPage(result);
      if (
        keyboard &&
        trigger &&
        (trigger === document.activeElement || (!trigger.isConnected && document.activeElement === document.body))
      )
        focusHeading();
    } else {
      setFailure(result);
      if (result.reason !== 'unavailable') {
        selectionOpener.current = null;
        keyboardSelection.current = false;
        origin.current = null;
        setSelectedKey(null);
        setPage(undefined);
      }
    }
  };
  useEffect(() => {
    mounted.current = true;
    if (!initial) void read({ id, context });
    return () => {
      mounted.current = false;
      inFlight.current = false;
      sequence.current++;
      origin.current = null;
    };
    // The parent remounts this window for every source, address, viewer or locale observation.
  }, []);
  const request = (address: AlbumTrackAddress, isPrevious = false) => (event: MouseEvent<HTMLButtonElement>) => {
    if (!busy) void read(address, event.currentTarget, event.detail === 0, isPrevious);
  };
  const selected = page?.rows.find((row) => `${row.holder}:${row.statementId}` === selectedKey);
  const currentSubjectHref = contextHref(
    subjectHref({ id, label: page?.album.label.text ?? '' }, locale).href,
    realm,
  );

  const closeInspection = () => {
    const opener = selectionOpener.current;
    selectionOpener.current = null;
    setSelectedKey(null);
    if (current() && opener?.isConnected) opener.focus();
    else focusHeading();
  };

  useLayoutEffect(() => {
    if (selectedKey && keyboardSelection.current) {
      keyboardSelection.current = false;
      inspectionHeading.current?.focus();
    }
  }, [selectedKey]);

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
          <a className={link} href={currentSubjectHref}>
            {m.album_tracks_subject_recovery({}, o)}
          </a>
        </div>
      ) : null}
      {page && !page.stream ? <p role="status">{m.album_tracks_unconfigured({}, o)}</p> : null}
      {streams.length ? (
        <nav className="flex min-w-0 flex-wrap gap-2" aria-label={m.work_parts_relation({}, o)}>
          {streams.map((stream) => (
            <button
              key={stream.key}
              type="button"
              aria-pressed={stream.key === selectedStream}
              disabled={busy}
              className={`${buttonVariants({ variant: 'outline' })} ${action}`}
              onClick={request({ ...base, stream: stream.key })}
            >
              <span lang={stream.label.lang ?? undefined}>{stream.label.text || stream.property}</span>
            </button>
          ))}
        </nav>
      ) : null}
      {page && page.stream ? (
        <>
          <dl className="grid min-w-0 gap-2 rounded-lg border border-border p-3 sm:grid-cols-2">
            <div className="min-w-0">
              <dt className="text-sm text-muted-foreground">{m.album_tracks_title({}, o)}</dt>
              <dd className="[overflow-wrap:anywhere]">
                <span lang={page.album.label.lang ?? undefined}>{page.album.label.text || page.album.id}</span>
                <span className="block text-sm text-muted-foreground">{page.album.id}</span>
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-sm text-muted-foreground">{m.work_parts_relation({}, o)}</dt>
              <dd className="[overflow-wrap:anywhere]">
                <span lang={page.stream.label.lang ?? undefined}>{page.stream.label.text || page.stream.property}</span>
                <span className="block text-sm">{page.stream.property}</span>
                <span className="block text-sm text-muted-foreground">
                  {page.stream.direction === 'forward'
                    ? m.work_parts_order_forward({}, o)
                    : m.work_parts_order_inverse({}, o)}
                </span>
              </dd>
            </div>
            {page.count ? (
              <div>
                <dt className="text-sm text-muted-foreground">
                  {page.count.exact ? m.work_parts_exact({}, o) : m.work_parts_at_least({}, o)}
                </dt>
                <dd>{page.count.value}</dd>
              </div>
            ) : null}
          </dl>
          <p className="text-sm text-muted-foreground">{m.work_parts_slice({}, o)}</p>
          <p role="status" className="text-sm text-muted-foreground">
            {page.caughtUp ? m.album_tracks_current({}, o) : m.work_parts_pending({}, o)}
          </p>
          {!page.rows.length ? <p role="status">{m.work_parts_empty({}, o)}</p> : null}
          <ul className="min-w-0 divide-y divide-border">
            {page.rows.map((row) => {
              const summary = row.summary;
              const type = summary ? page.types[summary.type] : undefined;
              const key = `${row.holder}:${row.statementId}`;
              return (
                <li key={key} data-slot="album-track-row" className="min-w-0">
                  <ContentItemFrame as="div" className="min-w-0 py-3 [overflow-wrap:anywhere]">
                    <button
                      data-slot="album-track-inspect"
                      type="button"
                      aria-expanded={selectedKey === key}
                      aria-controls={selectedKey === key ? inspectionId : undefined}
                      aria-label={`${m.album_tracks_inspect({}, o)}: ${summary?.label?.value || m.work_parts_unresolved({}, o)}; ${row.holder}; ${row.statementId}`}
                      disabled={busy}
                      className={`${action} w-full flex-col items-start gap-1 text-left`}
                      onClick={(event) => {
                        if (!current()) return;
                        selectionOpener.current = event.currentTarget;
                        keyboardSelection.current = event.detail === 0;
                        setSelectedKey(key);
                      }}
                    >
                      <span className="font-semibold" lang={summary?.label?.language}>
                        {summary?.label?.value || m.work_parts_unresolved({}, o)}
                      </span>
                      {summary ? (
                        <span className="text-sm">
                          {m.album_tracks_kind({}, o)}: <span lang={type?.lang ?? undefined}>{type?.text || summary.type}</span>
                        </span>
                      ) : null}
                      <span className="text-sm text-muted-foreground">{m.album_tracks_inspect({}, o)}</span>
                      <span className="text-xs text-muted-foreground">
                        {m.work_parts_holder({}, o)}: {row.holder} · {m.album_tracks_membership({}, o)}: {row.statementId}
                      </span>
                    </button>
                  </ContentItemFrame>
                </li>
              );
            })}
          </ul>
          {selected ? (() => {
            const summary = selected.summary;
            const type = summary ? page.types[summary.type] : undefined;
            const targetHref = summary
              ? contextHref(subjectHref({ id: summary.id, label: summary.label?.value ?? '' }, locale).href, realm)
              : undefined;
            const holderLabel = selected.holder === id ? page.album.label.text : summary?.label?.value ?? '';
            const holder = contextHref(subjectHref({ id: selected.holder, label: holderLabel }, locale).href, realm);
            const correction = contextHref(`${holder.split('?')[0]}/relation-edit`, realm);
            return (
              <section
                data-slot="album-track-inspection"
                id={inspectionId}
                role="region"
                aria-labelledby={inspectionHeadingId}
                className="min-w-0 space-y-4 rounded-lg border border-border p-4"
              >
                <header className="flex min-w-0 items-start justify-between gap-3">
                  <h3 id={inspectionHeadingId} ref={inspectionHeading} tabIndex={-1} className="font-semibold [overflow-wrap:anywhere]">
                    {summary?.label?.value || m.work_parts_unresolved({}, o)}
                  </h3>
                  <button
                    type="button"
                    className={`${buttonVariants({ variant: 'outline' })} ${action} shrink-0`}
                    onClick={closeInspection}
                  >
                    {m.candidate_close({}, o)}
                  </button>
                </header>
                <p className="text-sm text-muted-foreground">
                  {page.stream.direction === 'forward'
                    ? m.work_parts_order_forward({}, o)
                    : m.work_parts_order_inverse({}, o)}
                </p>
                {summary ? (
                  <div className="space-y-2">
                    <p className="text-sm">
                      <span>{m.album_tracks_kind({}, o)}: </span>
                      <span lang={type?.lang ?? undefined}>{type?.text || summary.type}</span>
                    </p>
                    {targetHref ? (
                      <a className={link} href={targetHref} target="_blank" rel="noopener" onClick={returnFocus}>
                        {m.album_tracks_open({}, o)}
                      </a>
                    ) : null}
                  </div>
                ) : (
                  <p>{m.work_parts_unresolved({}, o)}</p>
                )}
                <dl className="grid min-w-0 gap-2 sm:grid-cols-2">
                  <div>
                    <dt className="text-sm text-muted-foreground">{m.work_parts_holder({}, o)}</dt>
                    <dd className="[overflow-wrap:anywhere]">{selected.holder}</dd>
                  </div>
                  <div>
                    <dt className="text-sm text-muted-foreground">{m.album_tracks_membership({}, o)}</dt>
                    <dd className="[overflow-wrap:anywhere]">{selected.statementId}</dd>
                  </div>
                  <div>
                    <dt className="text-sm text-muted-foreground">{m.work_parts_relation({}, o)}</dt>
                    <dd className="[overflow-wrap:anywhere]">{page.stream.property}</dd>
                  </div>
                  {summary ? (
                    <div>
                      <dt className="text-sm text-muted-foreground">{m.album_tracks_target({}, o)}</dt>
                      <dd className="[overflow-wrap:anywhere]">{summary.id}</dd>
                    </div>
                  ) : null}
                </dl>
                {selected.statement ? (
                  <div className="space-y-3">
                    <h4 className="font-medium">{m.album_tracks_membership({}, o)}</h4>
                    <div>
                      <p className="text-sm text-muted-foreground">{m.album_tracks_target({}, o)}</p>
                      <CandidateValue
                        snak={selected.statement}
                        related={selected.statement.value.type === 'value' ? {} : selected.related}
                        locale={locale}
                      />
                    </div>
                    {selected.statement.qualifiers.length ? (
                      <dl className="space-y-2">
                        {selected.statement.qualifiers.map((snak, index) => (
                          <div key={index}>
                            <dt className="text-sm text-muted-foreground" lang={page.labels[snak.property.id]?.lang ?? undefined}>
                              {page.labels[snak.property.id]?.text || snak.property.id}
                            </dt>
                            <dd><CandidateValue snak={snak} related={selected.related} locale={locale} /></dd>
                          </div>
                        ))}
                      </dl>
                    ) : null}
                    <details className="min-w-0 rounded-lg border border-border p-3">
                      <summary className={`${action} cursor-pointer`}>{m.sources_citations({}, o)}</summary>
                      {selected.statement.references.length ? (
                        selected.statement.references.map((reference, index) => (
                          <dl key={index} className="mt-3 space-y-2">
                            {reference.parts.map((snak, part) => (
                              <div key={part}>
                                <dt lang={page.labels[snak.property.id]?.lang ?? undefined}>
                                  {page.labels[snak.property.id]?.text || snak.property.id}
                                </dt>
                                <dd><CandidateValue snak={snak} related={selected.related} locale={locale} /></dd>
                              </div>
                            ))}
                          </dl>
                        ))
                      ) : (
                        <p>{m.music_reader_source_unavailable({}, o)}</p>
                      )}
                    </details>
                  </div>
                ) : (
                  <p>{m.work_parts_assertion_unavailable({}, o)}</p>
                )}
                <details className="min-w-0 rounded-lg border border-border p-3">
                  <summary className={`${action} cursor-pointer`}>{m.catalogue_technical_details({}, o)}</summary>
                  <dl className="mt-3 space-y-2 text-sm [overflow-wrap:anywhere]">
                    <div><dt>{m.work_parts_holder({}, o)}</dt><dd>{selected.holder}</dd></div>
                    <div><dt>{m.album_tracks_membership({}, o)}</dt><dd>{selected.statementId}</dd></div>
                    {summary ? <div><dt>{m.album_tracks_target({}, o)}</dt><dd>{summary.id}</dd></div> : null}
                    <div><dt>{m.work_parts_relation({}, o)}</dt><dd>{page.stream.property}</dd></div>
                  </dl>
                </details>
                <a className={link} href={correction} target="_blank" rel="noopener" onClick={returnFocus}>
                  {m.album_tracks_correction({}, o)}
                </a>
              </section>
            );
          })() : null}
        </>
      ) : null}
      {page && !page.next && page.stream ? <p role="status">{m.album_tracks_complete({}, o)}</p> : null}
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          disabled={busy || previousCount === 0}
          className={`${buttonVariants({ variant: 'outline' })} ${action}`}
          onClick={request(priorAddresses.current.at(-1) ?? base, true)}
        >
          {m.album_tracks_previous({}, o)}
        </button>
        <button
          type="button"
          disabled={busy}
          className={`${buttonVariants({ variant: 'outline' })} ${action}`}
          onClick={request({ ...base, ...(selectedStream ? { stream: selectedStream } : {}) })}
        >
          {m.work_parts_restart({}, o)}
        </button>
        {failure ? (
          <button
            type="button"
            className={`${buttonVariants({ variant: 'outline' })} ${action}`}
            disabled={busy}
            onClick={(event) => read(pending.current, event.currentTarget, event.detail === 0, pendingIsPrevious.current)}
          >
            {m.album_tracks_retry({}, o)}
          </button>
        ) : null}
        {page?.next && !failure ? (
          <button
            type="button"
            disabled={busy}
            className={`${buttonVariants({ variant: 'outline' })} ${action}`}
            onClick={request({ ...base, stream: page.stream!.key, cursor: page.next })}
          >
            {m.work_parts_more({}, o)}
          </button>
        ) : null}
      </div>
    </div>
  );
}
