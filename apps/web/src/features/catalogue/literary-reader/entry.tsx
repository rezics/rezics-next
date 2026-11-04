import { useMemo, useRef, useSyncExternalStore } from 'react';
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
  const returnTo = literaryAddress({
    id: work.id,
    label: pageText(work.labels, locale).text,
    locale,
    view,
    realm,
    continuation,
  });
  const selected = useMemo(
    () => (definitions ? literaryWindows(windows, definitions, continuation?.node) : []),
    [windows, definitions, continuation?.node],
  );
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
        href={match ? literaryDestination(match[1]!, decodeURIComponent(match[2]!), locale, returnTo, realm) : href}
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
      recoveryHref={returnTo}
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
          {selected.length ? (
            selected.map((native) => {
              const direction = directions?.find(
                (admitted) => admitted.property === native.property && admitted.direction === native.direction,
              );
              const projected =
                direction?.state === 'admitted' && direction.release === digest
                  ? literaryWindow(native, work.id, locale, reader)
                  : {
                      native,
                      rows: [],
                      withheld: false,
                      state: direction?.state === 'unsupported' ? ('unsupported' as const) : ('unavailable' as const),
                    };
              const streamView =
                native.property === 'schema:exampleOfWork' ||
                native.property === 'schema:workExample' ||
                native.property === 'rezics:representativeEdition'
                  ? 'editions'
                  : 'contents';
              // Overview and full-view nodes need not have the same identity. Continue only the node actually mounted here.
              const currentView = view === 'overview' ? 'overview' : streamView;
              return (
                <LiteraryNativeWindow
                  key={native.node}
                  window={projected}
                  definitions={definitions}
                  locale={locale}
                  returnTo={returnTo}
                  realm={realm}
                  nextHref={
                    native.next && view !== 'overview'
                      ? literaryAddress({
                          id: work.id,
                          label: '',
                          locale,
                          view: currentView,
                          realm,
                          continuation: { node: native.node, cursor: native.next },
                        })
                      : native.next && value
                        ? (viewHref(value, streamView) ?? undefined)
                        : undefined
                  }
                  restartHref={literaryAddress({ id: work.id, label: '', locale, view: currentView, realm })}
                />
              );
            })
          ) : (
            <LiteraryStatus state="unsupported" locale={locale} />
          )}
        </>
      )}
    </LiteraryReader>
  );
}

export { literaryWorkIdentity, literaryAuthorityKey, literaryReaderRetired } from './model';
