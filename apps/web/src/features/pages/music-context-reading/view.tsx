import { useCallback, useEffect, useRef, useState } from 'react';
import { pickText } from '@rezics/composition';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../../paraglide/messages.js';
import { candidateContext } from '../visit-host-port';
import { useCatalogueLifetime } from '../../../subject/candidate-lifetime';
import { subjectHref } from '../../../subject/subject-href';
import { withSubjectVisitReturn } from '../subject-visit-navigation';
import { catalogueEntries } from '../../catalogue/catalogue-entry';
import type { MusicContextFailure, MusicContextKind, MusicContextRead } from '../../catalogue/music-context-profile';
import {
  musicContextAddressHref,
  musicContextRouteSearch,
  musicContextTargetHref,
  validatedMusicContextReturn,
  MUSIC_CONTEXT_ADDRESS_BYTE_CAP,
  type MusicContextAddress,
} from '../../catalogue/music-context-profile/navigation';
import { ViewHeading } from '../view-heading';

const actionClass =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere] py-2 md:pointer-fine:min-h-8 md:pointer-fine:py-1';
const linkClass =
  'inline-flex min-h-11 min-w-11 max-w-full items-center whitespace-normal underline underline-offset-4 [overflow-wrap:anywhere] rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
const HISTORY_CAP = 8;
const fitsRetainedAddress = (value: string) =>
  new TextEncoder().encode(value).byteLength <= MUSIC_CONTEXT_ADDRESS_BYTE_CAP;

export type MusicContextTransport = {
  read: (
    input: Pick<MusicContextAddress, 'context' | 'stream' | 'cursor'> & { session?: string | undefined },
  ) => Promise<MusicContextRead>;
};
type MusicContextReadingProps = {
  id: string;
  locale: string;
  context?: string | undefined;
  realm?: string | undefined;
  returnTo?: string | undefined;
  via?: string | undefined;
  transport: MusicContextTransport;
  initial?: MusicContextRead | undefined;
  initialStream?: string | undefined;
  initialCursor?: string | undefined;
  onAddressChange?: ((address: MusicContextAddressChange) => void) | undefined;
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

function addressHref(id: string, label: string, locale: string, address: MusicContextAddress): string | undefined {
  const base = catalogueEntries.musicContext({ id, label, locale }).href;
  return musicContextAddressHref(base, address, locale, id);
}

function currentAddress(
  id: string,
  label: string,
  locale: string,
  displayAddress: MusicContextAddress | undefined,
  requestedAddress: MusicContextAddress,
): string | undefined {
  return addressHref(id, label, locale, displayAddress ? { ...requestedAddress, ...displayAddress } : requestedAddress);
}

export function MusicContextReading(props: MusicContextReadingProps) {
  const transportIdentity = useRef({ value: props.transport, revision: 0 });
  if (transportIdentity.current.value !== props.transport) {
    transportIdentity.current = {
      value: props.transport,
      revision: transportIdentity.current.revision + 1,
    };
  }
  const binding = useCatalogueLifetime(
    JSON.stringify([
      'music-context-binding',
      props.id,
      props.locale,
      props.context ?? '',
      props.realm ?? '',
      props.returnTo ?? '',
      props.via ?? '',
      transportIdentity.current.revision,
    ]),
  );
  return <MusicContextReadingBound key={binding.generation} {...props} binding={binding} />;
}

function MusicContextReadingBound({
  id,
  locale,
  context,
  realm,
  returnTo,
  via,
  transport,
  initial,
  initialStream,
  initialCursor,
  onAddressChange,
  binding,
}: MusicContextReadingProps & { binding: ReturnType<typeof useCatalogueLifetime> }) {
  const o = { locale: locale as never };
  const selectedContext = context ?? candidateContext;
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
  const [relationshipFailure, setRelationshipFailure] = useState(!!seed?.relationsUnavailable);
  const [failedAddress, setFailedAddress] = useState<MusicContextAddress | undefined>(
    initial && !initial.ok
      ? { stream: initialStream, cursor: initialCursor }
      : seed?.relationsUnavailable
        ? { stream: initialStream ?? seed.stream, cursor: initialCursor }
        : undefined,
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
  const contextRef = useRef(selectedContext);
  const realmRef = useRef(realm);
  const returnToRef = useRef(returnTo);
  const viaRef = useRef(via);
  const addressChangeRef = useRef(onAddressChange);
  const routeAddressRef = useRef({ stream: initialStream, cursor: initialCursor });
  const releaseRef = useRef(seed?.public.subject.release);
  const [releaseEpoch, setReleaseEpoch] = useState(0);
  const [freshReadRequired, setFreshReadRequired] = useState(false);
  streamRef.current = streamIntent;
  epochRef.current = selectionEpoch;
  idRef.current = id;
  localeRef.current = locale;
  transportRef.current = transport;
  contextRef.current = selectedContext;
  realmRef.current = realm;
  returnToRef.current = returnTo;
  viaRef.current = via;
  addressChangeRef.current = onAddressChange;

  const lifetime = useCatalogueLifetime(
    JSON.stringify([
      'music-context',
      id,
      locale,
      context ?? '',
      realm ?? '',
      returnTo ?? '',
      via ?? '',
      transport,
      streamIntent ?? '',
      selectionEpoch,
      releaseEpoch,
    ]),
    binding,
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
      setFreshReadRequired(false);
      const sequence = ++requestSequence.current;
      const owner = {
        id,
        locale,
        context: selectedContext,
        realm,
        returnTo,
        via,
        stream: address.stream,
        transport,
        epoch: selectionEpoch,
        generation: lifetime.generation,
      };
      const isCurrent = () =>
        requestSequence.current === sequence &&
        idRef.current === owner.id &&
        localeRef.current === owner.locale &&
        contextRef.current === owner.context &&
        realmRef.current === owner.realm &&
        returnToRef.current === owner.returnTo &&
        viaRef.current === owner.via &&
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
      setRelationshipFailure(false);
      try {
        const result = await transport.read({
          context: selectedContext,
          ...(address.stream ? { stream: address.stream } : {}),
          ...(address.cursor ? { cursor: address.cursor } : {}),
          session: sessionRef.current,
        });
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
        const sourceRelease = result.public.subject.release;
        if (releaseRef.current !== undefined && releaseRef.current !== sourceRelease) {
          releaseRef.current = sourceRelease;
          sessionRef.current = undefined;
          requestSequence.current += 1;
          busyRef.current = false;
          setBusy(false);
          setFreshReadRequired(true);
          setFailure({ ok: false, reason: 'stale' });
          setFailedAddress({ stream: address.stream });
          setFailedCommit({ kind: 'initial' });
          setCursorIntent(undefined);
          setPageAddresses([undefined]);
          setPageIndex(0);
          setDisplayAddress(undefined);
          writeProfile(undefined);
          writeDisplayed(undefined);
          setRelationshipFailure(false);
          setSelectionEpoch((current) => current + 1);
          setReleaseEpoch((current) => current + 1);
          return;
        }
        releaseRef.current = sourceRelease;
        setFreshReadRequired(false);
        sessionRef.current = result.session;
        writeProfile(result);
        if (result.relationsUnavailable) {
          const retained = displayedRef.current;
          const selectedStream = address.stream ?? result.stream;
          const retainWindow =
            !!retained &&
            retained.public.subject.id === result.public.subject.id &&
            retained.public.subject.context === result.public.subject.context &&
            retained.public.subject.type === result.public.subject.type &&
            retained.public.subject.revision === result.public.subject.revision &&
            retained.public.subject.release === result.public.subject.release &&
            retained.stream === selectedStream;
          if (!retainWindow) {
            writeDisplayed(result);
            setDisplayAddress({ stream: selectedStream, cursor: address.cursor });
            setCursorIntent(address.cursor);
          }
          setRelationshipFailure(true);
          setFailedAddress({ ...address, ...(selectedStream ? { stream: selectedStream } : {}) });
          setFailedCommit(commit);
          setFailure(undefined);
          return;
        }
        setRelationshipFailure(false);
        writeDisplayed(result);
        setDisplayAddress({ stream: address.stream ?? result.stream, cursor: address.cursor });
        setCursorIntent(address.cursor);
        setFailure(undefined);
        setFailedAddress(undefined);
        if ((address.stream || address.cursor || commit.kind !== 'initial') && result.stream)
          addressChangeRef.current?.({
            ...(context !== undefined ? { context } : {}),
            ...(realm !== undefined ? { realm } : {}),
            stream: result.stream,
            ...(address.cursor ? { cursor: address.cursor } : {}),
          });
        if (!result.streamUnavailable) finishHistory();
      } catch (error) {
        if (!isCurrent()) return;
        if (!(error instanceof TypeError)) throw error;
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
    [
      context,
      id,
      lifetime,
      locale,
      pageIndex,
      realm,
      returnTo,
      selectionEpoch,
      selectedContext,
      streamIntent,
      transport,
      via,
      writeDisplayed,
      writeProfile,
    ],
  );
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;

  useEffect(() => {
    const previous = routeAddressRef.current;
    routeAddressRef.current = { stream: initialStream, cursor: initialCursor };
    if (previous.stream === initialStream && previous.cursor === initialCursor) return;
    const stateMatchesRoute = streamIntent === initialStream && cursorIntent === initialCursor;
    const displayedMatchesRoute = displayAddress?.stream === initialStream && displayAddress?.cursor === initialCursor;
    if (stateMatchesRoute || displayedMatchesRoute) return;
    requestSequence.current += 1;
    busyRef.current = false;
    setBusy(false);
    lifetime.retire();
    const nextEpoch = epochRef.current + 1;
    epochRef.current = nextEpoch;
    streamRef.current = initialStream;
    setSelectionEpoch(nextEpoch);
    setStreamIntent(initialStream);
    setCursorIntent(initialCursor);
    setPageAddresses([initialCursor]);
    setPageIndex(0);
    setFailure(undefined);
    setRelationshipFailure(false);
    setFailedAddress(undefined);
    setDisplayAddress(undefined);
    writeDisplayed(undefined);
  }, [cursorIntent, displayAddress, initialCursor, initialStream, lifetime, streamIntent, writeDisplayed]);

  useEffect(() => {
    if (!booted.current) {
      booted.current = true;
      if (initial !== undefined) return () => lifetime.retire();
    }
    if (realm && context === undefined) {
      setFreshReadRequired(true);
      return () => lifetime.retire();
    }
    if (!freshReadRequired)
      void dispatchRef.current({ stream: streamIntent, cursor: cursorIntent }, { kind: 'initial' }, true);
    return () => {
      requestSequence.current += 1;
      busyRef.current = false;
      lifetime.retire();
    };
  }, [context, lifetime.generation, realm]);

  const selectStream = (nextStream: string) => {
    if (!nextStream || nextStream === (streamIntent ?? displayed?.stream)) return;
    requestSequence.current += 1;
    busyRef.current = false;
    setBusy(false);
    lifetime.retire();
    if (onAddressChange) {
      onAddressChange({
        ...(context !== undefined ? { context } : {}),
        ...(realm !== undefined ? { realm } : {}),
        stream: nextStream,
      });
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

  const routeAddressMatches =
    !onAddressChange ||
    (streamIntent === initialStream && cursorIntent === initialCursor) ||
    (displayAddress?.stream === initialStream && displayAddress?.cursor === initialCursor);
  const page =
    routeAddressMatches && displayed && (streamIntent === undefined || displayed.stream === streamIntent)
      ? displayed
      : undefined;
  const selectedStream = streamIntent ?? page?.stream ?? profile?.stream;
  const streamAdmitted = profile?.streams.some((stream) => stream.id === selectedStream) ?? false;
  const relationshipCursorMismatch =
    !!relationshipFailure &&
    !!page &&
    !!failedAddress &&
    (failedAddress.stream !== page.stream || failedAddress.cursor !== displayAddress?.cursor);
  const pageHasRetainedData = !!page && !!(busy || failure || relationshipCursorMismatch);
  const title = profile ? pickText(profile.public.subject.labels, locale).text : '';
  const safeVia = via
    ? musicContextRouteSearch({ context: selectedContext, via }, locale, { subjectId: id })?.via
    : undefined;
  const safeReturn = validatedMusicContextReturn(returnTo, locale, id, selectedContext, realm);
  const visibleAddress = currentAddress(id, title, locale, page ? displayAddress : undefined, {
    ...(context !== undefined ? { context } : {}),
    ...(realm !== undefined ? { realm } : {}),
    stream: selectedStream,
    cursor: cursorIntent,
  });
  const currentReturn =
    safeVia ??
    (!realm && selectedContext === candidateContext
      ? (safeReturn ?? subjectHref({ id, label: title }, locale).href)
      : undefined);
  const canCorrect =
    routeAddressMatches &&
    !!profile &&
    profile.kind !== 'unsupported' &&
    !realm &&
    selectedContext === candidateContext;
  const correction = catalogueEntries.facts({ id, label: title, locale }).href;
  const correctionCandidate = visibleAddress
    ? `${correction}?${new URLSearchParams({ returnTo: visibleAddress })}`
    : correction;
  const correctionHref = fitsRetainedAddress(correctionCandidate) ? correctionCandidate : undefined;
  const nextCursor = page?.streamUnavailable || relationshipFailure ? null : page?.next;

  return (
    <article
      className="mx-auto w-full min-w-0 max-w-4xl space-y-6 [overflow-wrap:anywhere]"
      aria-busy={busy}
      data-slot="music-context-reading"
    >
      <ViewHeading label={m.music_context_title({}, o)} headingClassName="font-sans" />
      <p className="max-w-prose text-muted-foreground">{m.music_context_intro({}, o)}</p>
      {(!realm || context !== undefined) && (
        <p data-context={selectedContext}>{m.music_context_selected_context({ context: selectedContext }, o)}</p>
      )}
      {title && <h2 className="text-xl font-semibold">{title}</h2>}
      {realm && <p role="status">{m.music_context_realm_unsupported({}, o)}</p>}
      {realm && (
        <a className={linkClass} href={catalogueEntries.musicContext({ id, label: title, locale }).href}>
          {m.music_context_fresh_global({}, o)}
        </a>
      )}
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
          {relationshipFailure && (
            <div role="alert" className="space-y-2">
              <p>{m.music_context_relations_unavailable({}, o)}</p>
              {failedAddress && (
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
          )}
          {!relationshipFailure && !page?.streamUnavailable && page?.stream && page.links.length === 0 && (
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
                    (() => {
                      const target = subjectHref({ id: link.id, label: link.label }, locale).href;
                      const exactMusicTarget = !!link.targetKind && !realm;
                      const targetBase = exactMusicTarget
                        ? catalogueEntries.musicContext({
                            id: link.id,
                            label: link.label,
                            locale,
                            context: selectedContext,
                          }).href
                        : target;
                      const exactTargetWithReturn =
                        exactMusicTarget && link.id !== id && visibleAddress
                          ? musicContextTargetHref(targetBase, visibleAddress, locale, link.id)
                          : undefined;
                      const generalTargetWithReturn =
                        !exactMusicTarget && !realm && visibleAddress
                          ? withSubjectVisitReturn(target, visibleAddress, locale)
                          : target;
                      const generalTargetFits = fitsRetainedAddress(generalTargetWithReturn);
                      const href = exactMusicTarget
                        ? link.id === id || !visibleAddress
                          ? targetBase
                          : (exactTargetWithReturn ?? targetBase)
                        : realm || !visibleAddress
                          ? target
                          : generalTargetFits
                            ? generalTargetWithReturn
                            : target;
                      const needsExactNotice = !!realm || (selectedContext !== candidateContext && !link.targetKind);
                      const needsReturnNotice =
                        (exactMusicTarget && link.id !== id && !!visibleAddress && !exactTargetWithReturn) ||
                        (!exactMusicTarget && !realm && !!visibleAddress && !generalTargetFits);
                      return (
                        <>
                          <a className={linkClass} href={href}>
                            {exactMusicTarget
                              ? link.label || m.subject_value_unlabelled({}, o)
                              : needsExactNotice
                                ? m.music_context_open_general_target({}, o)
                                : link.label || m.subject_value_unlabelled({}, o)}
                          </a>
                          {needsExactNotice && (
                            <span className="ms-2 text-muted-foreground">
                              {m.music_context_exact_target_unsupported({}, o)}
                            </span>
                          )}
                          {needsReturnNotice && (
                            <span className="ms-2 text-muted-foreground">
                              {m.music_context_visit_return_unavailable({}, o)}
                            </span>
                          )}
                        </>
                      );
                    })()
                  )}
                  {!link.unreadable && link.date && (
                    <span className="ms-2">
                      {link.date.label}:{' '}
                      {link.date.time.state === 'supported' && link.date.time.structuredDate ? (
                        <time dateTime={link.date.time.structuredDate}>{link.date.time.text}</time>
                      ) : (
                        link.date.time.text
                      )}
                    </span>
                  )}
                  {!link.unreadable && link.role && (
                    <span className="ms-2">
                      {link.role.label}:{' '}
                      {link.role.target
                        ? (() => {
                            const target = link.role!.target!;
                            const targetBase =
                              target.targetKind && !realm
                                ? catalogueEntries.musicContext({
                                    id: target.id,
                                    label: target.label,
                                    locale,
                                    context: selectedContext,
                                  }).href
                                : subjectHref({ id: target.id, label: target.label }, locale).href;
                            const exact = !!target.targetKind && !realm;
                            const exactWithReturn =
                              exact && target.id !== id && visibleAddress
                                ? musicContextTargetHref(targetBase, visibleAddress, locale, target.id)
                                : undefined;
                            const generalWithReturn =
                              !exact && !realm && visibleAddress
                                ? withSubjectVisitReturn(targetBase, visibleAddress, locale)
                                : targetBase;
                            const generalFits = fitsRetainedAddress(generalWithReturn);
                            const href = exact
                              ? target.id === id || !visibleAddress
                                ? targetBase
                                : (exactWithReturn ?? targetBase)
                              : generalFits
                                ? generalWithReturn
                                : targetBase;
                            const returnUnavailable =
                              !!visibleAddress &&
                              ((exact && target.id !== id && !exactWithReturn) || (!exact && !realm && !generalFits));
                            return (
                              <>
                                <a className={linkClass} href={href}>
                                  {exact || (selectedContext === candidateContext && !realm)
                                    ? target.label || m.subject_value_unlabelled({}, o)
                                    : m.music_context_open_general_target({}, o)}
                                </a>
                                {(realm || (selectedContext !== candidateContext && !target.targetKind)) && (
                                  <span className="ms-2 text-muted-foreground">
                                    {m.music_context_exact_target_unsupported({}, o)}
                                  </span>
                                )}
                                {returnUnavailable && (
                                  <span className="ms-2 text-muted-foreground">
                                    {m.music_context_visit_return_unavailable({}, o)}
                                  </span>
                                )}
                              </>
                            );
                          })()
                        : link.role.unknown === 'novalue'
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

          {canCorrect && correctionHref && (
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
      {routeAddressMatches && currentReturn ? (
        <a className={linkClass} href={currentReturn}>
          {m.music_context_return_source({}, o)}
        </a>
      ) : routeAddressMatches ? (
        <div className="space-y-2">
          <p role="status">{m.music_context_exact_return_unsupported({}, o)}</p>
          <a className={linkClass} href={subjectHref({ id, label: title }, locale).href}>
            {m.music_context_open_general_subject({}, o)}
          </a>
        </div>
      ) : null}
    </article>
  );
}
