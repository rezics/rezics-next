import { useCallback, useEffect, useRef, useState } from 'react';
import { pickText } from '@rezics/composition';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../../paraglide/messages.js';
import { useCatalogueLifetime } from '../../../subject/candidate-lifetime';
import { subjectHref } from '../../../subject/subject-href';
import { subjectVisitReturn, withSubjectVisitReturn } from '../subject-visit-navigation';
import { catalogueEntries } from '../../catalogue/catalogue-entry';
import type { MusicContextFailure, MusicContextKind, MusicContextRead } from '../../catalogue/music-context-profile';
import type { MusicContextAddress } from '../../catalogue/music-context-profile/navigation';
import { ViewHeading } from '../view-heading';

const actionClass =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere] py-2 md:pointer-fine:min-h-8 md:pointer-fine:py-1';
const linkClass =
  'inline-flex min-h-11 min-w-11 max-w-full items-center whitespace-normal underline underline-offset-4 [overflow-wrap:anywhere] rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
const HISTORY_CAP = 8;

export type MusicContextTransport = {
  read: (input: MusicContextAddress & { session?: string | undefined }) => Promise<MusicContextRead>;
};
type HistoryCommit = { kind: 'initial' } | { kind: 'push' } | { kind: 'index'; index: number };
type MusicContextAddressChange = MusicContextAddress & { stream: string };
type MusicContextSuccess = Extract<MusicContextRead, { ok: true }>;

function profileSnapshot(value: MusicContextSuccess): MusicContextSuccess {
  return {
    ok: true,
    public: value.public,
    kind: value.kind,
    facts: value.facts,
    streams: value.streams,
    links: [],
    next: null,
    ...(value.stream ? { stream: value.stream } : {}),
  };
}

function kindLabel(kind: MusicContextKind, locale: string) {
  const o = { locale: locale as never };
  if (kind === 'place') return m.music_context_place({}, o);
  if (kind === 'event') return m.music_context_event({}, o);
  if (kind === 'area') return m.music_context_area({}, o);
  if (kind === 'instrument') return m.music_context_instrument({}, o);
  return m.music_context_unsupported_type({}, o);
}

function failureMessage(failure: MusicContextFailure, locale: string) {
  const o = { locale: locale as never };
  if (failure.reason === 'denied') return m.music_context_denied({}, o);
  if (failure.reason === 'stale') return m.music_context_stale({}, o);
  if (failure.reason === 'preparing') return m.music_context_preparing({}, o);
  if (failure.reason === 'invalid') return m.music_context_invalid_address({}, o);
  return m.music_context_unavailable({}, o);
}

function addressHref(id: string, label: string, locale: string, address: MusicContextAddress): string {
  const target = new URL(catalogueEntries.musicContext({ id, label, locale }).href, 'https://rezics.invalid');
  if (address.stream) target.searchParams.set('stream', address.stream);
  if (address.cursor && address.stream) target.searchParams.set('cursor', address.cursor);
  return `${target.pathname}${target.search}`;
}

function currentAddress(
  id: string,
  label: string,
  locale: string,
  displayAddress: MusicContextAddress | undefined,
  requestedAddress: MusicContextAddress,
): string {
  return addressHref(id, label, locale, displayAddress ?? requestedAddress);
}

export function MusicContextReading({
  id,
  locale,
  returnTo,
  transport,
  initial,
  initialStream,
  initialCursor,
  onAddressChange,
}: {
  id: string;
  locale: string;
  returnTo?: string | undefined;
  transport: MusicContextTransport;
  initial?: MusicContextRead | undefined;
  initialStream?: string | undefined;
  initialCursor?: string | undefined;
  onAddressChange?: ((address: MusicContextAddressChange) => void) | undefined;
}) {
  const o = { locale: locale as never };
  const seed = initial?.ok ? initial : undefined;
  const seedProfile = seed ? profileSnapshot(seed) : undefined;
  const [streamIntent, setStreamIntent] = useState(initialStream ?? seed?.stream);
  const [selectionEpoch, setSelectionEpoch] = useState(0);
  const [cursorIntent, setCursorIntent] = useState(initialCursor);
  const [pageAddresses, setPageAddresses] = useState<Array<string | undefined>>([initialCursor]);
  const [pageIndex, setPageIndex] = useState(0);
  const [profile, setProfile] = useState(seedProfile);
  const [displayed, setDisplayed] = useState(seed);
  const [displayAddress, setDisplayAddress] = useState<MusicContextAddress | undefined>(
    seed ? { stream: seed.stream ?? initialStream, cursor: initialCursor } : undefined,
  );
  const [failure, setFailure] = useState<MusicContextFailure | undefined>(initial && !initial.ok ? initial : undefined);
  const [failedAddress, setFailedAddress] = useState<MusicContextAddress | undefined>(
    initial && !initial.ok ? { stream: initialStream, cursor: initialCursor } : undefined,
  );
  const [failedCommit, setFailedCommit] = useState<HistoryCommit>({ kind: 'initial' });
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const requestSequence = useRef(0);
  const booted = useRef(false);
  const profileRef = useRef(seedProfile);
  const displayedRef = useRef(seed);
  const sessionRef = useRef(seed?.session);
  const streamRef = useRef(streamIntent);
  const epochRef = useRef(selectionEpoch);
  const idRef = useRef(id);
  const localeRef = useRef(locale);
  const transportRef = useRef(transport);
  const addressChangeRef = useRef(onAddressChange);
  streamRef.current = streamIntent;
  epochRef.current = selectionEpoch;
  idRef.current = id;
  localeRef.current = locale;
  transportRef.current = transport;
  addressChangeRef.current = onAddressChange;

  const lifetime = useCatalogueLifetime(
    JSON.stringify(['music-context', id, locale, streamIntent ?? '', selectionEpoch]),
  );

  const writeDisplayed = useCallback((value: Extract<MusicContextRead, { ok: true }> | undefined) => {
    displayedRef.current = value;
    setDisplayed(value);
  }, []);
  const writeProfile = useCallback((value: Extract<MusicContextRead, { ok: true }> | undefined) => {
    const snapshot = value ? profileSnapshot(value) : undefined;
    profileRef.current = snapshot;
    setProfile(snapshot);
  }, []);

  const dispatch = useCallback(
    async (address: MusicContextAddress, commit: HistoryCommit, replace = false) => {
      if ((busyRef.current && !replace) || !lifetime.active()) return;
      const sequence = ++requestSequence.current;
      const owner = {
        id,
        locale,
        stream: address.stream,
        transport,
        epoch: selectionEpoch,
        generation: lifetime.generation,
      };
      const isCurrent = () =>
        requestSequence.current === sequence &&
        idRef.current === owner.id &&
        localeRef.current === owner.locale &&
        transportRef.current === owner.transport &&
        epochRef.current === owner.epoch &&
        (streamRef.current === undefined || owner.stream === undefined || streamRef.current === owner.stream) &&
        lifetime.generation === owner.generation &&
        lifetime.active();
      const finishHistory = () => {
        if (commit.kind === 'index') {
          setPageIndex(commit.index);
          return;
        }
        if (commit.kind !== 'push' || !address.cursor) return;
        setPageAddresses((current) => {
          const next = current.slice(0, pageIndex + 1);
          if (next[next.length - 1] !== address.cursor) next.push(address.cursor);
          const bounded = next.length > HISTORY_CAP ? next.slice(-HISTORY_CAP) : next;
          setPageIndex(bounded.length - 1);
          return bounded;
        });
      };

      busyRef.current = true;
      setBusy(true);
      setFailure(undefined);
      setFailedAddress(undefined);
      try {
        const result = await transport.read({ ...address, session: sessionRef.current });
        if (!isCurrent()) return;
        if (!result.ok) {
          if (result.reason === 'denied' || result.reason === 'stale') sessionRef.current = undefined;
          if (result.reason === 'denied') {
            writeProfile(undefined);
            writeDisplayed(undefined);
            setDisplayAddress(undefined);
          } else if (result.reason === 'stale' && displayedRef.current) {
            writeDisplayed({ ...displayedRef.current, session: undefined });
            if (profileRef.current) writeProfile({ ...profileRef.current, session: undefined });
          }
          setFailure(result);
          setFailedAddress(address);
          setFailedCommit(commit);
          return;
        }
        sessionRef.current = result.session;
        writeProfile(result);
        writeDisplayed(result);
        setDisplayAddress({ stream: address.stream ?? result.stream, cursor: address.cursor });
        setCursorIntent(address.cursor);
        setFailure(undefined);
        setFailedAddress(undefined);
        if (streamIntent && result.stream)
          addressChangeRef.current?.({ stream: result.stream, ...(address.cursor ? { cursor: address.cursor } : {}) });
        if (!result.streamUnavailable) finishHistory();
      } catch {
        if (!isCurrent()) return;
        setFailure({ ok: false, reason: 'unavailable' });
        setFailedAddress(address);
        setFailedCommit(commit);
      } finally {
        if (isCurrent()) {
          busyRef.current = false;
          setBusy(false);
        }
      }
    },
    [id, lifetime, locale, pageIndex, selectionEpoch, streamIntent, transport, writeDisplayed, writeProfile],
  );
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;

  useEffect(() => {
    if (!booted.current) {
      booted.current = true;
      if (initial !== undefined) return () => lifetime.retire();
    }
    void dispatchRef.current({ stream: streamIntent, cursor: cursorIntent }, { kind: 'initial' }, true);
    return () => {
      requestSequence.current += 1;
      busyRef.current = false;
      lifetime.retire();
    };
  }, [lifetime.generation]);

  const selectStream = (nextStream: string) => {
    if (!nextStream || nextStream === (streamIntent ?? displayed?.stream)) return;
    requestSequence.current += 1;
    busyRef.current = false;
    setBusy(false);
    lifetime.retire();
    if (onAddressChange) {
      onAddressChange({ stream: nextStream });
      return;
    }
    const nextEpoch = epochRef.current + 1;
    epochRef.current = nextEpoch;
    streamRef.current = nextStream;
    setSelectionEpoch(nextEpoch);
    setStreamIntent(nextStream);
    setCursorIntent(undefined);
    setPageAddresses([undefined]);
    setPageIndex(0);
    setFailure(undefined);
    setFailedAddress(undefined);
    setDisplayAddress(undefined);
    writeDisplayed(undefined);
  };

  const page = displayed && (streamIntent === undefined || displayed.stream === streamIntent) ? displayed : undefined;
  const selectedStream = streamIntent ?? page?.stream ?? profile?.stream;
  const streamAdmitted = profile?.streams.some((stream) => stream.id === selectedStream) ?? false;
  const pageHasRetainedData = !!page && !!(busy || failure);
  const title = profile ? pickText(profile.public.subject.labels, locale).text : '';
  const safeReturn = subjectVisitReturn(returnTo, locale);
  const profileReturn = safeReturn ?? subjectHref({ id, label: title }, locale).href;
  const visibleAddress = currentAddress(id, title, locale, page ? displayAddress : undefined, {
    stream: selectedStream,
    cursor: cursorIntent,
  });
  const canCorrect = !!profile && profile.kind !== 'unsupported';
  const correction = catalogueEntries.facts({ id, label: title, locale }).href;
  const correctionHref = `${correction}?${new URLSearchParams({ returnTo: visibleAddress })}`;
  const nextCursor = page?.streamUnavailable ? null : page?.next;

  return (
    <article
      className="mx-auto w-full min-w-0 max-w-4xl space-y-6 [overflow-wrap:anywhere]"
      aria-busy={busy}
      data-slot="music-context-reading"
    >
      <ViewHeading label={m.music_context_title({}, o)} headingClassName="font-sans" />
      <p className="max-w-prose text-muted-foreground">{m.music_context_intro({}, o)}</p>
      {busy && <p role="status">{m.music_context_page_loading({}, o)}</p>}
      {failure && (
        <p role="alert" tabIndex={-1}>
          {failureMessage(failure, locale)}
        </p>
      )}
      {pageHasRetainedData && <p role="status">{m.music_context_last_good({}, o)}</p>}
      {profile?.kind === 'unsupported' && <p role="status">{kindLabel(profile.kind, locale)}</p>}
      {profile && profile.kind !== 'unsupported' && (
        <div className="space-y-5">
          <p>{kindLabel(profile.kind, locale)}</p>
          {profile.facts.length > 0 && (
            <dl className="grid min-w-0 gap-x-5 gap-y-3 sm:grid-cols-[minmax(8rem,0.35fr)_minmax(0,1fr)]">
              {profile.facts.map((fact, index) => (
                <div
                  className="grid min-w-0 gap-1 sm:col-span-2 sm:grid-cols-subgrid"
                  key={`${fact.property}:${index}`}
                >
                  <dt className="font-medium">{fact.label}</dt>
                  <dd className="min-w-0 [overflow-wrap:anywhere]">
                    {fact.time ? (
                      fact.time.state === 'supported' && fact.time.structuredDate ? (
                        <time dateTime={fact.time.structuredDate}>{fact.time.text}</time>
                      ) : (
                        fact.time.text
                      )
                    ) : fact.unknown === 'coordinates-unsupported' ? (
                      m.music_context_coordinates_unsupported({}, o)
                    ) : fact.unknown === 'novalue' ? (
                      m.subject_value_none({}, o)
                    ) : fact.unknown === 'somevalue' ? (
                      m.subject_value_unknown({}, o)
                    ) : fact.unknown ? (
                      m.music_context_unknown_value({}, o)
                    ) : (
                      fact.text
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          )}

          {profile.streams.length > 0 && (
            <div className="max-w-xl space-y-2">
              <label className="block font-medium" htmlFor="music-context-stream">
                {m.music_context_stream_label({}, o)}
              </label>
              <select
                id="music-context-stream"
                className="min-h-11 w-full min-w-0 rounded-md border border-input bg-background px-3 py-2 text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                value={selectedStream ?? ''}
                onChange={(event) => selectStream(event.currentTarget.value)}
              >
                {!selectedStream && <option value="">{m.music_context_stream_choose({}, o)}</option>}
                {selectedStream && !streamAdmitted && (
                  <option value={selectedStream}>{m.music_context_stream_missing({}, o)}</option>
                )}
                {profile.streams.map((stream) => (
                  <option key={stream.id} value={stream.id}>
                    {stream.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          {page?.streamUnavailable && <p role="alert">{m.music_context_stream_missing({}, o)}</p>}
          {!page?.streamUnavailable && profile.streams.length === 0 && (
            <p role="status">{m.music_context_no_streams({}, o)}</p>
          )}
          {!page?.streamUnavailable && page?.stream && page.links.length === 0 && (
            <p role="status">{m.music_context_empty_page({}, o)}</p>
          )}
          {!!page?.links.length && (
            <ol className="space-y-2" aria-label={profile.streams.find((stream) => stream.id === page.stream)?.label}>
              {page.links.map((link, index) => (
                <li
                  key={link.occurrence ?? `${link.property}:${link.id}:${link.position ?? index + 1}`}
                  className="min-w-0 [overflow-wrap:anywhere]"
                  data-occurrence={link.occurrence ?? link.position ?? index + 1}
                >
                  <span className="text-muted-foreground">{link.position ?? index + 1}. </span>
                  {link.unreadable ? (
                    <span>{m.music_context_unreadable_endpoint({}, o)}</span>
                  ) : (
                    <a
                      className={linkClass}
                      href={withSubjectVisitReturn(
                        subjectHref({ id: link.id, label: link.label }, locale).href,
                        visibleAddress,
                        locale,
                      )}
                    >
                      {link.label || m.subject_value_unlabelled({}, o)}
                    </a>
                  )}
                  {link.date && (
                    <span className="ms-2">
                      {link.date.label}:{' '}
                      {link.date.time.state === 'supported' && link.date.time.structuredDate ? (
                        <time dateTime={link.date.time.structuredDate}>{link.date.time.text}</time>
                      ) : (
                        link.date.time.text
                      )}
                    </span>
                  )}
                  {link.role && (
                    <span className="ms-2">
                      {link.role.label}:{' '}
                      {link.role.unknown === 'novalue'
                        ? m.subject_value_none({}, o)
                        : link.role.unknown === 'somevalue'
                          ? m.subject_value_unknown({}, o)
                          : link.role.unknown
                            ? m.music_context_unknown_value({}, o)
                            : link.role.text}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          )}

          <div className="flex flex-wrap gap-3">
            {pageIndex > 0 && page?.stream && !failure && (
              <Button
                type="button"
                variant="outline"
                className={actionClass}
                disabled={busy}
                onClick={() =>
                  void dispatch(
                    { stream: page.stream, cursor: pageAddresses[pageIndex - 1] },
                    { kind: 'index', index: pageIndex - 1 },
                  )
                }
              >
                {m.music_context_previous_page({}, o)}
              </Button>
            )}
            {nextCursor && page?.stream && !failure && (
              <Button
                type="button"
                variant="outline"
                className={actionClass}
                disabled={busy}
                onClick={() => {
                  const nextIndex = pageIndex + 1;
                  const retained = pageAddresses[nextIndex];
                  void dispatch(
                    { stream: page.stream, cursor: retained ?? nextCursor },
                    retained !== undefined ? { kind: 'index', index: nextIndex } : { kind: 'push' },
                  );
                }}
              >
                {m.music_context_next_page({}, o)}
              </Button>
            )}
            {failure && failedAddress && (
              <Button
                type="button"
                variant="outline"
                className={actionClass}
                disabled={busy}
                onClick={() => void dispatch(failedAddress, failedCommit)}
              >
                {m.music_context_retry_page({}, o)}
              </Button>
            )}
          </div>

          {canCorrect && (
            <a className={linkClass} href={correctionHref}>
              {m.music_context_correct({}, o)}
            </a>
          )}
        </div>
      )}
      {!profile && failure && failedAddress && (
        <Button
          type="button"
          variant="outline"
          className={actionClass}
          disabled={busy}
          onClick={() => void dispatch(failedAddress, failedCommit)}
        >
          {m.music_context_retry_page({}, o)}
        </Button>
      )}
      <a className={linkClass} href={profileReturn}>
        {m.music_context_return_source({}, o)}
      </a>
    </article>
  );
}
