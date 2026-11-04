import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { PageContinuation, SelectedContext } from '@rezics/composition';
import type { ReleasedRelationDirectionResult } from '@rezics/definitions';
import { browserObservation } from '../../../session';
import type { Subject, Related } from '../../../subject/types';
import type { Reader } from '../../../subject/reader';
import { defaultReader } from '../../../subject/reader';
import { m } from '../../../paraglide/messages.js';
import { useOverview, viewHref } from '../../pages/overview';
import { pageText, type PageLink } from '../../pages/shared';
import type { ProfileRelationWindow } from '../../pages/views';
import { literaryAddress, literaryDestination } from './navigation';
import {
  literaryGrain,
  literarySelected,
  literaryWindow,
  literaryWindowKind,
  literaryWindowState,
  literaryWindows,
  literaryWorkIdentity,
  type LiteraryDefinitions,
} from './model';
import { LiteraryReader } from './view';
import { LiteraryAssertionView, LiteraryNativeWindow, LiteraryStatus } from './sections';

const fields = [
  'schema:contributor',
  'schema:author',
  'schema:illustrator',
  'schema:translator',
  'schema:publisher',
  'schema:inLanguage',
  'schema:datePublished',
  'schema:startDate',
  'schema:endDate',
  'wdt:P2635',
  'schema:isbn',
  'schema:numberOfPages',
  'wdt:P179',
  'schema:isPartOf',
  'schema:exampleOfWork',
];

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
    reader,
    view,
    realm,
    continuation,
    selectedNode,
    selectedStreamProperty,
    selectedStreamDirection,
    viewer,
  ]);
  const captured = useRef<{
    source: object;
    identity: string;
    authority: typeof authority;
    definitions: typeof definitions;
    retired: boolean;
    generation: number;
  } | null>(null);
  if (!captured.current || captured.current.source !== source) {
    captured.current = {
      source,
      identity,
      authority,
      definitions,
      retired: seen.current.has(source),
      generation: (captured.current?.generation ?? 0) + 1,
    };
    seen.current.add(source);
  } else {
    if (captured.current.authority.state === 'unknown' && authority.state !== 'unknown' && !captured.current.retired)
      captured.current.authority = authority;
    if (
      captured.current.identity !== identity ||
      captured.current.authority !== authority ||
      captured.current.definitions !== definitions
    )
      captured.current.retired = true;
  }
  const retired = captured.current.retired;
  const supplied = useMemo(() => (definitions ? literaryWindows(windows, definitions) : []), [windows, definitions]);
  const requestedNode = selectedNode ?? continuation?.node;
  const requestedStream = requestedNode ? supplied.find((native) => native.node === requestedNode) : undefined;
  const expectsStream = selectedStreamProperty !== undefined || selectedStreamDirection !== undefined;
  const selectionLost =
    (expectsStream &&
      (!requestedStream ||
        requestedStream.property !== selectedStreamProperty ||
        requestedStream.direction !== selectedStreamDirection)) ||
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
  const routeFor = (native: ProfileRelationWindow) => {
    const kind = definitions ? literaryWindowKind(native, definitions) : undefined;
    return view === 'overview' ? 'overview' : kind === 'editions' ? 'editions' : 'contents';
  };
  const addressFor = (native: ProfileRelationWindow, addressView: string, keepCursor: boolean) =>
    literaryAddress({
      id: work.id,
      label: pageText(work.labels, locale).text,
      locale,
      view: addressView,
      realm,
      stream: { node: native.node, property: native.property, direction: native.direction },
      ...(keepCursor &&
      view !== 'overview' &&
      addressView === view &&
      continuation?.node === native.node
        ? { continuation }
        : {}),
    });
  const recoveryHref = literaryAddress({ id: work.id, label: '', locale, view, realm });
  const requestedReturn =
    requestedStream && !selectionLost
      ? addressFor(requestedStream, routeFor(requestedStream), true)
      : literaryAddress({
          id: work.id,
          label: pageText(work.labels, locale).text,
          locale,
          view,
          realm,
          ...(view !== 'overview' && continuation ? { continuation } : {}),
        });
  const activeFor = (kind: 'members' | 'editions') => {
    if (selectionLost) return undefined;
    if (requestedStream && definitions && literaryWindowKind(requestedStream, definitions) === kind) return requestedStream;
    return supplied.find((native) => definitions && literaryWindowKind(native, definitions) === kind);
  };
  const activeMembers = activeFor('members');
  const activeEditions = activeFor('editions');
  const windowState = (native: ProfileRelationWindow) => {
    const direction = directions?.find(
      (admitted) => admitted.property === native.property && admitted.direction === native.direction,
    );
    if (direction?.state !== 'admitted' || direction.release !== digest)
      return direction?.state === 'unsupported' ? ('unsupported' as const) : ('unavailable' as const);
    return literaryWindowState(native, work.id, locale, reader);
  };
  const o = { locale: locale as never };
  const grain = literaryGrain(work.type, definitions);
  const type = pageText(definitions?.types[work.type]?.labels, locale);
  const matching = value?.subject === work.id && (value.context?.id ?? null) === (context?.id ?? null);
  const factsHref =
    matching && value
      ? viewHref(value, 'details')
      : literaryAddress({ id: work.id, label: '', locale, view: 'details', realm });
  const editionHref = matching && value?.sections.has('editions') ? viewHref(value, 'editions') : undefined;
  const Link: PageLink = ({ href, ...props }) => {
    const destination = new URL(href, 'https://rezics.invalid');
    const match = /^\/[^/]+\/subjects\/([^/]+)\/([^/]+)/.exec(destination.pathname);
    return (
      <a
        {...props}
        href={match ? literaryDestination(match[1]!, decodeURIComponent(match[2]!), locale, requestedReturn, realm) : href}
        target="_blank"
        rel="noopener noreferrer"
      />
    );
  };
  return (
    <LiteraryReader
      key={captured.current.generation}
      identity={literaryWorkIdentity(work, locale)}
      locale={locale}
      editionHref={editionHref ?? undefined}
      factsHref={factsHref ?? undefined}
      retired={retired}
      recoveryHref={recoveryHref}
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
          <dl className="grid min-w-0 gap-4 sm:grid-cols-2">
            {fields.flatMap((property) => {
              if (!definitions.types[work.type]?.properties.includes(property)) return [];
              const statements = literarySelected(work, property, reader);
              const label = pageText(definitions.properties[property]?.labels, locale);
              const membership = property === 'wdt:P179' || property === 'schema:isPartOf';
              const canonical = property === 'schema:exampleOfWork';
              if (!statements.length && !canonical) return [];
              const relation = definitions.properties[property]?.relation;
              const admitted = directions?.find(
                (direction) => direction.property === property && direction.direction === 'forward',
              );
              const relationUnavailable = relation && (admitted?.state !== 'admitted' || admitted.release !== digest);
              const withheld = !statements.length && (work.relationCounts?.[property] ?? 0) > 0;
              return [
                <div key={property} className="min-w-0 space-y-1" data-property={property}>
                  <dt lang={label.lang} className="text-sm font-medium">
                    {label.text || m.subject_value_unlabelled({}, o)}
                  </dt>
                  <dd className="min-w-0 space-y-3 [overflow-wrap:anywhere]">
                    {relationUnavailable ? (
                      <LiteraryStatus
                        state={admitted?.state === 'unsupported' ? 'unsupported' : 'unavailable'}
                        locale={locale}
                      />
                    ) : (
                      statements.map((statement) => (
                        <LiteraryAssertionView
                          key={statement.id}
                          assertion={{ statement, related }}
                          definitions={definitions}
                          locale={locale}
                          link={Link}
                          membership={membership}
                        />
                      ))
                    )}
                    {!relationUnavailable &&
                      !statements.length &&
                      (withheld ? (
                        <LiteraryStatus state="withheld" locale={locale} />
                      ) : (
                        <p role="status">{m.literary_grain_mapping_missing({}, o)}</p>
                      ))}
                  </dd>
                </div>,
              ];
            })}
          </dl>
          {selectionLost ? (
            <div role="status" data-state="unavailable" className="space-y-2 text-sm text-muted-foreground">
              <p>{m.literary_grain_stream_missing({}, o)}</p>
              <a
                href={recoveryHref}
                className="inline-flex min-h-11 min-w-11 max-w-full items-center py-2 text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {m.literary_grain_stream_recover({}, o)}
              </a>
            </div>
          ) : (
            <div className="space-y-6">
              {(['members', 'editions'] as const).map((kind) => {
                const candidates = supplied.filter((native) => definitions && literaryWindowKind(native, definitions) === kind);
                const active = kind === 'members' ? activeMembers : activeEditions;
                const heading = kind === 'members' ? m.literary_grain_members({}, o) : m.literary_grain_editions({}, o);
                const renderNative = (native: ProfileRelationWindow) => {
                  const projectedDirection = directions?.find(
                    (admitted) => admitted.property === native.property && admitted.direction === native.direction,
                  );
                  const state = windowState(native);
                  const projected =
                    projectedDirection?.state === 'admitted' && projectedDirection.release === digest
                      ? literaryWindow(native, work.id, locale, reader)
                      : {
                          native,
                          rows: [],
                          withheld: false,
                          state: projectedDirection?.state === 'unsupported' ? ('unsupported' as const) : ('unavailable' as const),
                        };
                  const streamView = kind === 'editions' ? 'editions' : 'contents';
                  const currentView = routeFor(native);
                  const stream = { node: native.node, property: native.property, direction: native.direction };
                  const returnTo = addressFor(native, currentView, true);
                  const nextHref =
                    native.next && view !== 'overview'
                      ? literaryAddress({
                          id: work.id,
                          label: '',
                          locale,
                          view: currentView,
                          realm,
                          stream,
                          continuation: { node: native.node, cursor: native.next },
                        })
                      : native.next && value
                        ? (viewHref(value, streamView) ?? undefined)
                        : undefined;
                  const retryHref = state === 'unavailable' ? addressFor(native, currentView, true) : undefined;
                  const restartHref = literaryAddress({ id: work.id, label: '', locale, view: currentView, realm, stream });
                  return (
                    <LiteraryNativeWindow
                      key={native.node}
                      window={projected}
                      definitions={definitions}
                      locale={locale}
                      returnTo={returnTo}
                      realm={realm}
                      nextHref={nextHref}
                      retryHref={retryHref}
                      restartHref={restartHref}
                      continued={view !== 'overview' && continuation?.node === native.node}
                    />
                  );
                };
                return (
                  <div key={kind} className="space-y-3">
                    <h3 className="font-medium">{heading}</h3>
                    {candidates.length ? (
                      <nav aria-label={heading}>
                        <ul className="grid min-w-0 gap-2 sm:grid-cols-2">
                          {candidates.map((native) => {
                            const property = definitions.properties[native.property];
                            const label = pageText(
                              native.direction === 'inverse' ? property?.relation?.inverseLabels : property?.labels,
                              locale,
                            );
                            const directionLabel =
                              native.direction === 'inverse'
                                ? m.literary_grain_direction_inverse({}, o)
                                : m.literary_grain_direction_forward({}, o);
                            const current = active?.node === native.node;
                            const addressView = routeFor(native);
                            const href = addressFor(native, addressView, current);
                            const state = windowState(native);
                            return (
                              <li key={native.node} data-stream-node={native.node} className="min-w-0 rounded-md border border-border p-2">
                                <a
                                  href={href}
                                  aria-current={current ? 'page' : undefined}
                                  aria-label={`${m.literary_grain_stream_read({}, o)}: ${label.text}, ${directionLabel}`}
                                  className="flex min-h-11 min-w-11 max-w-full flex-wrap items-center gap-x-2 gap-y-1 text-primary underline underline-offset-4 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                                >
                                  <span lang={label.lang} className="font-medium">
                                    {label.text || m.subject_relations({}, o)}
                                  </span>
                                  <span className="text-sm">{directionLabel}</span>
                                  <span className="text-sm text-muted-foreground">
                                    {current
                                      ? m.literary_grain_stream_selected({}, o)
                                      : m.literary_grain_stream_not_selected({}, o)}
                                  </span>
                                  <span className="sr-only">{m.literary_grain_stream_read({}, o)}</span>
                                </a>
                                <div data-state={state} className="pt-1">
                                  <LiteraryStatus state={state} locale={locale} />
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                      </nav>
                    ) : (
                      <LiteraryStatus state="unsupported" locale={locale} />
                    )}
                    {active ? renderNative(active) : null}
                  </div>
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
