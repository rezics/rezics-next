import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { PageContinuation, SelectedContext } from '@rezics/composition';
import type { ReleasedRelationDirectionResult } from '@rezics/definitions';
import { browserObservation } from '../../../session';
import type { Subject, Related } from '../../../subject/types';
import type { Reader } from '../../../subject/reader';
import { defaultReader } from '../../../subject/reader';
import { m } from '../../../paraglide/messages.js';
import { pageText, type PageLink } from '../../pages/shared';
import type { ProfileRelationWindow } from '../../pages/views';
import { useOverview } from '../../pages/overview';
import { literaryAddress, literaryDestination } from './navigation';
import { appendLiteraryPrevious, literaryFocusId } from '../literary-visit/navigation';
import { useLiteraryVisitLocation } from '../literary-visit/location';
import {
  literaryGrain,
  literaryFocuses,
  literaryWindow,
  literaryWindowKind,
  literaryWindowState,
  literaryWindows,
  literaryWorkIdentity,
  type LiteraryDefinitions,
  type LiteraryWindow,
} from './model';
import { LiteraryReader } from './view';
import { LiteraryNativeWindow, LiteraryStatus } from './sections';
import { LiteraryFacts } from './facts';
import { LiteraryStreams } from './streams';
import { LiteraryOverviewDestinations } from './overview';
import { literaryFields, literaryView, literaryVisibleFamily } from './presentation';

/** No read is started here. Metadata, assertions and windows all belong to the ordinary native page. */
export function LiteraryReaderEntry({
  work,
  related = {},
  source,
  locale,
  context,
  definitions,
  directions,
  descriptorState,
  digest,
  windows = [],
  reader = defaultReader,
  view = 'overview',
  realm,
  continuation,
  selectedNode,
  selectedStreamProperty,
  selectedStreamDirection,
  viewer = null,
}: {
  work: Subject;
  related?: Related;
  source: object;
  locale: string;
  context?: SelectedContext | null | undefined;
  definitions?: LiteraryDefinitions | undefined;
  directions?: ReleasedRelationDirectionResult[] | undefined;
  descriptorState?: 'released' | 'unsupported' | 'unavailable' | undefined;
  digest?: string | undefined;
  windows?: readonly ProfileRelationWindow[];
  reader?: Reader;
  view?: string;
  realm?: string | undefined;
  continuation?: PageContinuation | undefined;
  selectedNode?: string | undefined;
  selectedStreamProperty?: string | undefined;
  selectedStreamDirection?: 'forward' | 'inverse' | undefined;
  viewer?: string | null;
}) {
  const overview = useOverview('');
  const value = overview?.value;
  const client = useQueryClient();
  const store = browserObservation(client);
  const authority = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  const seen = useRef(new WeakSet<object>());
  const identity = JSON.stringify([
    work.id,
    work.type,
    context,
    locale,
    digest,
    view,
    realm,
    continuation,
    selectedNode,
    selectedStreamProperty,
    selectedStreamDirection,
    viewer,
  ]);
  const preferences = `${reader.spoilerLevel}:${reader.suitability}`;
  const visit = useLiteraryVisitLocation();
  const contextMismatch = visit.hasContext && (visit.invalid || visit.context !== (context?.id ?? undefined));
  const currentPrevious = visit.invalid || contextMismatch ? [] : visit.previous;
  const requestedFocus = visit.invalid || contextMismatch ? undefined : visit.focus;
  const captured = useRef<{
    source: object;
    identity: string;
    authority: typeof authority;
    preferences: string | undefined;
    definitions: typeof definitions;
    retired: boolean;
    generation: number;
  } | null>(null);
  if (!captured.current || captured.current.source !== source) {
    captured.current = {
      source,
      identity,
      authority,
      preferences: reader === defaultReader ? undefined : preferences,
      definitions,
      retired: seen.current.has(source),
      generation: (captured.current?.generation ?? 0) + 1,
    };
    seen.current.add(source);
  } else {
    if (captured.current.authority.state === 'unknown' && authority.state !== 'unknown' && !captured.current.retired)
      captured.current.authority = authority;
    // The ordinary page supplies the shared sentinel until actual preferences arrive, even at default values.
    if (captured.current.preferences === undefined && reader !== defaultReader && !captured.current.retired)
      captured.current.preferences = preferences;
    if (
      captured.current.identity !== identity ||
      captured.current.authority !== authority ||
      (captured.current.preferences !== undefined && captured.current.preferences !== preferences) ||
      captured.current.definitions !== definitions
    )
      captured.current.retired = true;
  }
  const retired = captured.current.retired;
  const supplied = useMemo(() => (definitions ? literaryWindows(windows, definitions) : []), [windows, definitions]);
  const requestedNode = selectedNode ?? continuation?.node;
  const expectsStream = selectedStreamProperty !== undefined || selectedStreamDirection !== undefined;
  const requestedStream = requestedNode
    ? supplied.find(
        (native) =>
          native.node === requestedNode &&
          (!expectsStream ||
            (native.property === selectedStreamProperty && native.direction === selectedStreamDirection)),
      )
    : undefined;
  const selectionLost =
    (expectsStream && !requestedStream) ||
    (requestedNode !== undefined && !requestedStream) ||
    (selectedNode !== undefined && continuation !== undefined && selectedNode !== continuation.node);
  const focusedRetiredStream =
    typeof document !== 'undefined' &&
    selectionLost &&
    document.activeElement instanceof Element &&
    !!document.activeElement.closest('[data-slot="literary-reader"]') &&
    !!document.activeElement.closest('[data-stream-node], [data-slot="literary-window"]');
  useEffect(() => {
    if (focusedRetiredStream) document.getElementById('literary-reader-title')?.focus();
  }, [source, focusedRetiredStream]);
  const readingRetired = retired || contextMismatch;
  const activeFor = (kind: 'members' | 'editions') => {
    if (selectionLost) return undefined;
    if (requestedStream && definitions && literaryWindowKind(requestedStream, definitions) === kind)
      return requestedStream;
    return supplied.find((native) => definitions && literaryWindowKind(native, definitions) === kind);
  };
  const activeMembers = activeFor('members');
  const activeEditions = activeFor('editions');
  const presentationView = literaryView(view);
  const visibleFamily = literaryVisibleFamily(presentationView);
  const grain = literaryGrain(work.type, definitions);
  const active =
    visibleFamily === 'members' ? activeMembers : visibleFamily === 'editions' ? activeEditions : undefined;
  // Share this one projection with rendering and focus admission; choices retain only their native window.
  const activeWindow = useMemo(() => {
    if (!active || readingRetired || !grain || descriptorState !== 'released') return undefined;
    const direction = directions?.find(
      (admitted) => admitted.property === active.property && admitted.direction === active.direction,
    );
    return direction?.state === 'admitted' && direction.release === digest
      ? literaryWindow(active, work.id, locale, reader)
      : {
          native: active,
          rows: [],
          withheld: false,
          state: direction?.state === 'unsupported' ? ('unsupported' as const) : ('unavailable' as const),
        };
  }, [
    active,
    readingRetired,
    grain,
    descriptorState,
    directions,
    digest,
    work.id,
    locale,
    reader.spoilerLevel,
    reader.suitability,
  ]);
  const windowState = (native: ProfileRelationWindow) => {
    if (activeWindow?.native === native) return activeWindow.state;
    const direction = directions?.find(
      (admitted) => admitted.property === native.property && admitted.direction === native.direction,
    );
    if (direction?.state !== 'admitted' || direction.release !== digest)
      return direction?.state === 'unsupported' ? ('unsupported' as const) : ('unavailable' as const);
    return literaryWindowState(native, work.id, locale, reader);
  };
  const admittedFocus = new Set(
    !readingRetired && definitions && grain && descriptorState === 'released'
      ? literaryFocuses(
          work,
          definitions,
          directions,
          digest,
          reader,
          literaryFields(presentationView),
          activeWindow,
        ).map(literaryFocusId)
      : [],
  );
  const currentFocus =
    requestedFocus && admittedFocus.has(literaryFocusId(requestedFocus)) ? requestedFocus : undefined;
  const focusedAssertion =
    typeof document !== 'undefined' && document.activeElement instanceof Element
      ? document.activeElement.closest('[id^="literary-row-"]')
      : null;
  const focusedDisclosureLost =
    !!focusedAssertion?.closest('[data-slot="literary-reader"]') && !admittedFocus.has(focusedAssertion.id);
  useEffect(() => {
    if (focusedDisclosureLost) document.getElementById('literary-reader-title')?.focus();
  }, [focusedDisclosureLost, source]);
  const routeFor = (native: ProfileRelationWindow) => {
    const kind = definitions ? literaryWindowKind(native, definitions) : undefined;
    return view === 'overview' ? 'overview' : kind === 'editions' ? 'editions' : 'contents';
  };
  const addressFor = (
    native: ProfileRelationWindow,
    addressView: string,
    keepCursor: boolean,
    focus?: string,
    previous = currentPrevious,
  ) =>
    literaryAddress({
      id: work.id,
      label: pageText(work.labels, locale).text,
      locale,
      view: addressView,
      realm,
      context,
      stream: { node: native.node, property: native.property, direction: native.direction },
      ...(keepCursor && view !== 'overview' && addressView === view && continuation?.node === native.node
        ? { continuation }
        : {}),
      focus,
      previous,
    });
  const returnAddressFor = (
    focus: string,
    addressView = view,
    addressContinuation = continuation,
    native: ProfileRelationWindow | undefined = requestedStream,
  ) =>
    literaryAddress({
      id: work.id,
      label: pageText(work.labels, locale).text,
      locale,
      view: addressView,
      realm,
      context,
      ...(native
        ? { stream: { node: native.node, property: native.property, direction: native.direction } }
        : addressView === 'overview'
          ? {}
          : { node: addressContinuation?.node }),
      ...(addressView !== 'overview' && addressContinuation ? { continuation: addressContinuation } : {}),
      focus,
      previous: currentPrevious,
    });
  const returnTo =
    requestedStream && !selectionLost
      ? addressFor(requestedStream, view, true, currentFocus)
      : literaryAddress({
          id: work.id,
          label: pageText(work.labels, locale).text,
          locale,
          view,
          realm,
          context,
          ...(view !== 'overview' && continuation ? { continuation } : {}),
          focus: currentFocus,
          previous: currentPrevious,
        });
  const freshAddress = literaryAddress({ id: work.id, label: '', locale, view: 'overview', realm, context });
  const recoveryHref = selectionLost ? freshAddress : contextMismatch ? freshAddress : returnTo;
  const o = { locale: locale as never };
  const type = pageText(definitions?.types[work.type]?.labels, locale);
  const matching = value?.subject === work.id && (value.context?.id ?? null) === (context?.id ?? null);
  const factsHref = literaryAddress({ id: work.id, label: '', locale, view: 'details', realm, context }).replace(
    /#literary-reader$/,
    '',
  );
  const editionHref =
    matching && value?.sections.has('editions')
      ? literaryAddress({ id: work.id, label: '', locale, view: 'editions', realm, context }).replace(
          /#literary-reader$/,
          '',
        )
      : undefined;
  const sourcesHref = literaryAddress({ id: work.id, label: '', locale, view: 'sources', realm, context }).replace(
    /#literary-reader$/,
    '',
  );
  const linkFor =
    (returnAddress: string): PageLink =>
    ({ href, ...props }) => {
      const destination = new URL(href, 'https://rezics.invalid');
      const match = /^\/[^/]+\/subjects\/([^/]+)\/([^/]+)/.exec(destination.pathname);
      return match ? (
        <a
          {...props}
          href={literaryDestination(match[1]!, decodeURIComponent(match[2]!), locale, returnAddress, realm, context)}
          target="_blank"
          rel="noopener noreferrer"
        />
      ) : (
        <a {...props} href={href} />
      );
    };
  const [focusMissing, setFocusMissing] = useState(false);
  useEffect(() => {
    if (!requestedFocus || readingRetired || typeof document === 'undefined') {
      setFocusMissing(false);
      return;
    }
    const target = currentFocus ? document.getElementById(literaryFocusId(currentFocus)) : null;
    if (target && document.activeElement === document.body) {
      (target as HTMLElement).focus();
      setFocusMissing(false);
    } else {
      setFocusMissing(!target);
    }
  }, [requestedFocus, currentFocus, readingRetired, source, supplied]);
  return (
    <LiteraryReader
      key={captured.current.generation}
      identity={literaryWorkIdentity(work, locale)}
      locale={locale}
      view={presentationView}
      composed={matching === true}
      editionHref={editionHref ?? undefined}
      factsHref={factsHref ?? undefined}
      retired={readingRetired}
      recoveryHref={recoveryHref}
      sourcesHref={sourcesHref}
      shelfType={descriptorState === 'released' && grain ? work.type : undefined}
      scopeText={m.literary_grain_scope({}, o)}
      grainLabel={
        type.text ? (
          <p lang={type.lang} data-type={work.type} className="text-sm text-muted-foreground">
            {type.text}
          </p>
        ) : null
      }
    >
      {!definitions || !grain || descriptorState !== 'released' ? (
        <LiteraryStatus state={descriptorState === 'unsupported' ? 'unsupported' : 'unavailable'} locale={locale} />
      ) : (
        <>
          <LiteraryFacts
            work={work}
            related={related}
            definitions={definitions}
            directions={directions}
            digest={digest}
            reader={reader}
            locale={locale}
            view={presentationView}
            returnToFor={returnAddressFor}
            linkFor={linkFor}
            currentFocus={currentFocus}
          />
          {presentationView === 'overview' && (
            <LiteraryOverviewDestinations
              subject={work.id}
              locale={locale}
              context={context}
              realm={realm}
              views={[
                ...(activeMembers ? ['contents'] : []),
                ...(activeEditions || editionHref ? ['editions'] : []),
                ...(work.statements['rezics:crossMediaCounterpart']?.length ? ['relations'] : []),
              ]}
            />
          )}
          {focusMissing && (
            <p role="status" className="text-sm text-muted-foreground">
              {m.literary_visit_currentness({}, o)}
            </p>
          )}
          {selectionLost ? (
            <div role="status" data-state="unavailable" className="space-y-2 text-sm text-muted-foreground">
              <p>{m.literary_grain_stream_missing({}, o)}</p>
              <a
                href={freshAddress}
                className="inline-flex min-h-11 min-w-11 max-w-full items-center py-2 text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {m.literary_grain_stream_recover({}, o)}
              </a>
            </div>
          ) : (
            <div className="space-y-6">
              {(visibleFamily ? [visibleFamily] : []).map((kind) => {
                const candidates = supplied.filter(
                  (native) => definitions && literaryWindowKind(native, definitions) === kind,
                );
                const heading = kind === 'members' ? m.literary_grain_members({}, o) : m.literary_grain_editions({}, o);
                const streamView = kind === 'editions' ? 'editions' : 'contents';
                const renderNative = (projected: LiteraryWindow) => {
                  const native = projected.native;
                  const state = projected.state;
                  const stream = { node: native.node, property: native.property, direction: native.direction };
                  const current =
                    view === streamView &&
                    active?.node === native.node &&
                    active.property === native.property &&
                    active.direction === native.direction;
                  const currentPage: import('../literary-visit/navigation').LiteraryPreviousAddress = {
                    view: streamView,
                    node: native.node,
                    streamProperty: native.property,
                    streamDirection: native.direction,
                    ...(continuation?.node === native.node ? { cursor: continuation.cursor } : {}),
                    ...(currentFocus ? { focus: currentFocus } : {}),
                  };
                  const nextHistory = appendLiteraryPrevious(currentPrevious, currentPage);
                  const rowContinuation = continuation?.node === native.node ? continuation : undefined;
                  const rowReturnTo = (focus: string) => returnAddressFor(focus, streamView, rowContinuation, native);
                  const previous = currentPrevious.at(-1);
                  const previousHref =
                    current && previous
                      ? literaryAddress({
                          id: work.id,
                          label: '',
                          locale,
                          view: previous.view,
                          realm,
                          context,
                          ...(previous.streamProperty && previous.streamDirection && previous.node
                            ? {
                                stream: {
                                  node: previous.node,
                                  property: previous.streamProperty,
                                  direction: previous.streamDirection,
                                },
                              }
                            : previous.node
                              ? { node: previous.node }
                              : {}),
                          ...(previous.node && previous.cursor
                            ? { continuation: { node: previous.node, cursor: previous.cursor } }
                            : {}),
                          focus: previous.focus,
                          previous: currentPrevious.slice(0, -1),
                        })
                      : undefined;
                  const returnHref = addressFor(native, routeFor(native), current, current ? currentFocus : undefined);
                  const nextHref = native.next
                    ? literaryAddress({
                        id: work.id,
                        label: '',
                        locale,
                        view: streamView,
                        realm,
                        context,
                        stream,
                        continuation: { node: native.node, cursor: native.next },
                        previous: nextHistory,
                      })
                    : undefined;
                  return (
                    <LiteraryNativeWindow
                      key={`${native.node}:${native.property}:${native.direction}`}
                      window={projected}
                      definitions={definitions}
                      locale={locale}
                      returnToFor={rowReturnTo}
                      realm={realm}
                      context={context}
                      rootLabel={literaryWorkIdentity(work, locale).title.text}
                      nextHref={nextHref}
                      retryHref={state === 'unavailable' ? returnHref : undefined}
                      restartHref={literaryAddress({
                        id: work.id,
                        label: '',
                        locale,
                        view: streamView,
                        realm,
                        context,
                        stream,
                      })}
                      previousHref={previousHref}
                      continued={view !== 'overview' && continuation?.node === native.node}
                    />
                  );
                };
                return (
                  <LiteraryStreams
                    key={kind}
                    candidates={candidates}
                    active={active}
                    definitions={definitions}
                    locale={locale}
                    heading={heading}
                    stateFor={windowState}
                    hrefFor={(native, current) =>
                      addressFor(native, routeFor(native), current, current ? currentFocus : undefined)
                    }
                  >
                    {activeWindow ? renderNative(activeWindow) : null}
                  </LiteraryStreams>
                );
              })}
            </div>
          )}
        </>
      )}
    </LiteraryReader>
  );
}

export { literaryWorkIdentity, literaryAuthorityKey, literaryReaderRetired } from './model';
