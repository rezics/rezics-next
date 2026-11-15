import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { cn } from '@rezics/ui/utils';
import { subjectHref } from '../../../subject/load-subject';
import type { Subject } from '../../../subject/types';
import type { RelationDefinition } from '../../../subject/relations';
import type { Reader } from '../../../subject/reader';
import { m } from '../../../paraglide/messages.js';
import { pageText, PlainLink, type PageLink } from '../../pages/shared';
import { WorkReadingProvider, useWorkReading, type WorkReadingPort } from '../work-reading-port';
import type { ProfileRelationWindow } from '../../pages/views';
import {
  mangaReaderMeasures,
  mangaReaderPreferences,
  mangaReaderRetired,
  mangaReaderRows,
  mangaReaderWindowScope,
  mangaReaderWindowStatus,
  type MangaReaderObservation,
  type MangaReaderRow,
  type MangaWindowStatus,
} from './model';
import { originalLanguage } from '../../../subject/language';
import { MangaOccurrenceEvidence, type MangaPropertyLabels } from './evidence';
import {
  mangaOccurrenceKey,
  mangaOccurrenceFromFragment,
  mangaRestartAddress,
  mangaSelectedAddress,
  mangaWindowAddress,
} from './navigation';
import { withSubjectVisitReturn } from '../../pages/subject-visit-navigation';

const textLink = cn(
  buttonVariants({ variant: 'link' }),
  'h-auto min-h-7 max-w-full justify-start whitespace-normal py-1 text-start [overflow-wrap:anywhere]',
  'underline',
);
const compactWrap =
  'h-auto min-h-6 max-w-full justify-start whitespace-normal text-start [overflow-wrap:anywhere]';

function options(locale: string) {
  return { locale: locale as never };
}

function statusText(status: MangaWindowStatus, locale: string) {
  const o = options(locale);
  switch (status) {
    case 'unsupported':
      return m.manga_reader_window_unsupported({}, o);
    case 'withheld':
      return m.manga_reader_window_withheld({}, o);
    case 'unavailable':
      return m.manga_reader_window_unavailable({}, o);
    case 'empty-exhausted':
      return m.manga_reader_window_empty({}, o);
    case 'empty-continued':
      return m.manga_reader_window_empty_more({}, o);
    case 'populated':
      return m.manga_reader_window_populated({}, o);
  }
}

function rowType(row: MangaReaderRow, locale: string) {
  const o = options(locale);
  if (row.type === 'schema:PublicationVolume') return m.manga_reader_volume({}, o);
  if (row.type === 'schema:ComicSeries') return m.manga_reader_series({}, o);
  return null;
}

export function MangaReader({
  subject,
  locale,
  view,
  windows,
  definitions,
  reader,
  observation,
  recoveryHref,
  currentHref,
  propertyLabels,
  link = PlainLink,
  reading,
}: {
  subject: Subject;
  locale: string;
  view: string;
  windows: readonly ProfileRelationWindow[];
  definitions: Record<string, RelationDefinition>;
  reader: Reader;
  observation: MangaReaderObservation;
  recoveryHref: string;
  currentHref?: string | undefined;
  propertyLabels?: MangaPropertyLabels | undefined;
  link?: PageLink;
  reading?: WorkReadingPort;
}) {
  const currentObservation = { ...observation, reader: mangaReaderPreferences(reader) };
  const captured = useRef<MangaReaderObservation | null>(currentObservation);
  const retiredVisit = useRef(false);
  const [selected, select] = useState<string | null>(null);
  const [, refreshLifetime] = useReducer((version: number) => version + 1, 0);
  const heading = useRef<HTMLHeadingElement>(null);
  const focused = useRef<EventTarget | null>(null);
  if (captured.current && mangaReaderRetired(captured.current, currentObservation)) {
    retiredVisit.current = true;
    captured.current = null;
  } else if (captured.current?.reader === undefined && !retiredVisit.current) {
    // Bind once, including actual default-valued preferences, before comparing later observations.
    captured.current = currentObservation;
  }
  const retired = retiredVisit.current;
  useEffect(() => {
    const retire = () => {
      if (retiredVisit.current) return;
      retiredVisit.current = true;
      captured.current = null;
      refreshLifetime();
    };
    const restore = () => {
      if (retiredVisit.current) refreshLifetime();
    };
    window.addEventListener('pagehide', retire);
    window.addEventListener('pageshow', restore);
    return () => {
      window.removeEventListener('pagehide', retire);
      window.removeEventListener('pageshow', restore);
    };
  }, []);
  const current = mangaReaderWindowScope(windows, definitions, view);
  const states = current.length
    ? current.map((window) => ({
        key: window.node,
        label:
          window.direction === 'forward'
            ? definitions[window.property]?.forwardLabel || definitions[window.property]?.label || ''
            : definitions[window.property]?.label || '',
        status: mangaReaderWindowStatus([window], definitions, reader, subject.id),
        next: window.next,
        kind: mangaReaderWindowScope([window], definitions, 'editions').length
          ? ('editions' as const)
          : ('contents' as const),
      }))
    : [{ key: 'unsupported', label: '', status: 'unsupported' as const, next: undefined, kind: 'contents' as const }];
  const state = states.every(({ status }) => status === states[0]?.status) ? states[0]!.status : 'mixed';
  const rows = retired ? [] : mangaReaderRows(current, definitions, locale, reader, subject);
  const originHandled = useRef(false);
  const rowControls = useRef(new Map<string, HTMLButtonElement>());
  const [missingOrigin, setMissingOrigin] = useState(false);
  const active = rows.find((row) => row.key === selected);
  useLayoutEffect(() => {
    if (!retired && (!selected || active)) return;
    if (selected) select(null);
    const target = focused.current;
    focused.current = null;
    // Removed evidence cannot retain selection or steal focus from another control.
    if (
      target instanceof Element &&
      target.closest('[data-selected="true"]') &&
      !target.isConnected &&
      document.activeElement === document.body
    )
      heading.current?.focus();
  }, [retired, selected, active]);
  useLayoutEffect(() => {
    if (retired || originHandled.current) return;
    const fragment = new URL(currentHref ?? recoveryHref, 'https://rezics.invalid').hash;
    const occurrence = mangaOccurrenceFromFragment(fragment);
    if (!occurrence) {
      originHandled.current = true;
      return;
    }
    const key = mangaOccurrenceKey(occurrence);
    const row = rows.find((candidate) => candidate.key === key);
    // Safe defaults may conceal a pending return. Resolve it against the first actual disclosure.
    if (!row && currentObservation.reader === undefined) return;
    originHandled.current = true;
    if (row) select(key);
    else setMissingOrigin(true);
    // Only an explicit occurrence return may move focus, and only while focus is still unclaimed.
    if (document.activeElement === document.body) {
      if (row) rowControls.current.get(key)?.focus();
      else heading.current?.focus();
    }
  }, [retired, currentHref, recoveryHref, rows, currentObservation.reader]);
  useEffect(() => {
    if (!retired) return;
    rowControls.current.clear();
  }, [retired]);
  const measures = retired ? [] : mangaReaderMeasures(current, definitions, reader, subject.id);
  const groups = new Map<
    string,
    { property: string; relation: string; kind: 'contents' | 'editions'; direction: string; rows: MangaReaderRow[] }
  >();
  for (const row of rows) {
    const key = `${row.property}:${row.direction}`;
    const group = groups.get(key) ?? {
      property: row.property,
      relation:
        row.direction === 'forward'
          ? definitions[row.property]?.forwardLabel || definitions[row.property]?.label || ''
          : definitions[row.property]?.label || '',
      kind: row.group,
      direction: row.direction,
      rows: [],
    };
    group.rows.push(row);
    groups.set(key, group);
  }
  const typeLabel =
    subject.type === 'schema:ComicSeries'
      ? m.manga_reader_series({}, options(locale))
      : m.manga_reader_volume({}, options(locale));
  const streamLabel =
    view === 'editions'
      ? m.manga_reader_editions({}, options(locale))
      : view === 'contents'
        ? m.manga_reader_parts({}, options(locale))
        : undefined;
  const title = pageText(subject.labels, locale, originalLanguage(subject));
  const Link = link;
  const port = useWorkReading(reading);
  const selectedAddress = (row: MangaReaderRow) => mangaSelectedAddress(recoveryHref, row.occurrence);
  const selectedReturn = active ? selectedAddress(active) : recoveryHref;
  const EvidenceLink = useMemo<PageLink>(
    () =>
      function OccurrenceLink(props) {
        return <Link {...props} href={withSubjectVisitReturn(props.href, selectedReturn, locale)} />;
      },
    [Link, locale, selectedReturn],
  );
  return (
    <WorkReadingProvider port={port}>
      <section
        id="manga-reader"
        data-slot="manga-reader"
        data-state={retired ? 'stale' : state}
        aria-labelledby="manga-reader-title"
        className={`${port.sectionClass} min-w-0 space-y-5 rounded-lg border border-border p-4 sm:p-6`}
        onFocusCapture={(event) => {
          focused.current = event.target;
        }}
      >
        <h2
          ref={heading}
          id="manga-reader-title"
          tabIndex={-1}
          className="text-xl leading-snug font-semibold tracking-tight sm:text-2xl"
        >
          {m.manga_reader_title({}, options(locale))}
        </h2>
        <div className="min-w-0 space-y-1">
          <p className="min-w-0 text-lg leading-snug font-semibold [overflow-wrap:anywhere]">
            <span lang={title.lang}>{title.text || m.subject_value_unlabelled({}, options(locale))}</span>
          </p>
          <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
            {typeLabel}
            {streamLabel ? ` · ${streamLabel}` : ''}
          </p>
        </div>
        {retired ? (
          <div role="status" className="space-y-2 text-sm text-muted-foreground">
            <p>{m.manga_reader_stale({}, options(locale))}</p>
            <a className={textLink} href={recoveryHref}>
              {m.manga_reader_recover({}, options(locale))}
            </a>
            <a
              className={textLink}
              href={mangaRestartAddress(recoveryHref)}
            >
              {m.manga_reader_restart({}, options(locale))}
            </a>
          </div>
        ) : (
          <>
            {missingOrigin ? (
              <div role="status" className="space-y-1 text-sm text-muted-foreground">
                <p>{m.manga_reader_origin_missing({}, options(locale))}</p>
                <a
                  className={textLink}
                  href={mangaRestartAddress(recoveryHref)}
                >
                  {m.manga_reader_restart({}, options(locale))}
                </a>
              </div>
            ) : null}
            <p className="sr-only" role="status" aria-live="polite">
              {active
                ? m.manga_reader_selected(
                    { label: active.label || m.subject_value_unlabelled({}, options(locale)) },
                    options(locale),
                  )
                : ''}
            </p>
            <ul className="grid min-w-0 gap-3 sm:grid-cols-2">
              {states.map(({ key, label, status, next, kind }) => (
                <li key={key} role="status" className="min-w-0 space-y-2 rounded-md border border-border p-3">
                  <h3 className="font-medium [overflow-wrap:anywhere]">
                    {streamLabel ??
                      (kind === 'editions'
                        ? m.manga_reader_editions({}, options(locale))
                        : m.manga_reader_parts({}, options(locale)))}
                    {label ? ` · ${label}` : ''}
                  </h3>
                  <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
                    {statusText(status, locale)}
                  </p>
                  {status === 'unavailable' ? (
                    <div className="flex flex-wrap gap-x-4">
                      <a href={recoveryHref} className={textLink}>
                        {m.manga_reader_retry({}, options(locale))}
                      </a>
                      <a
                        href={mangaRestartAddress(recoveryHref)}
                        className={textLink}
                      >
                        {m.manga_reader_restart({}, options(locale))}
                      </a>
                    </div>
                  ) : null}
                  {status === 'populated' || status === 'empty-continued' ? (
                    view === 'overview' ? (
                      <Link
                        href={mangaWindowAddress(
                          { id: subject.id, label: title.text },
                          locale,
                          kind,
                          observation.realm,
                        )}
                        className={textLink}
                      >
                        {kind === 'editions'
                          ? m.manga_reader_open_editions({}, options(locale))
                          : m.manga_reader_open_contents({}, options(locale))}
                      </Link>
                    ) : next ? (
                      <Link
                        href={mangaWindowAddress(
                          { id: subject.id, label: title.text },
                          locale,
                          kind,
                          observation.realm,
                          {
                            node: key,
                            cursor: next,
                          },
                        )}
                        className={textLink}
                      >
                        {m.manga_reader_next({}, options(locale))}
                      </Link>
                    ) : null
                  ) : null}
                </li>
              ))}
            </ul>
            <div className="min-w-0 space-y-2 border-t border-border pt-4 text-sm text-muted-foreground">
              <p className="[overflow-wrap:anywhere]">{m.manga_reader_chapters_unsupported({}, options(locale))}</p>
              {measures.length > 0 && (
                <ul className="space-y-1">
                  {measures.map((measure) => (
                    <li key={measure.key} className="[overflow-wrap:anywhere]">
                      {m.manga_reader_public_count(
                        {
                          label: measure.label || measure.property,
                          count: measure.count.value,
                          accuracy:
                            measure.count.relation === 'exact'
                              ? m.manga_reader_exact({}, options(locale))
                              : m.manga_reader_at_least({}, options(locale)),
                        },
                        options(locale),
                      )}
                      {measure.continued ? ` · ${m.manga_reader_more_window({}, options(locale))}` : ''}
                    </li>
                  ))}
                </ul>
              )}
              <p className="[overflow-wrap:anywhere]">{m.manga_reader_public_count_scope({}, options(locale))}</p>
            </div>
            {groups.size > 0 && (
              <section className="min-w-0 space-y-3">
                <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
                  {m.manga_reader_native_order({}, options(locale))}
                </p>
                {[...groups.entries()].map(([key, group]) => (
                  <section key={key} className="min-w-0 space-y-2">
                    <h3 className="text-base font-medium [overflow-wrap:anywhere]">
                      {group.kind === 'editions'
                        ? m.manga_reader_editions({}, options(locale))
                        : m.manga_reader_parts({}, options(locale))}
                      {group.relation ? ` · ${group.relation}` : ''}
                    </h3>
                    <ul className="min-w-0 divide-y divide-border">
                      {group.rows.map((row) => {
                        const label = row.label || m.subject_value_unlabelled({}, options(locale));
                        const type = rowType(row, locale);
                        const selectedRow = row.key === selected;
                        return (
                          <li
                            key={row.key}
                            data-statement-id={row.statementId}
                            data-node={row.node}
                            data-selected={selectedRow ? 'true' : undefined}
                            className="min-w-0 space-y-3 py-3"
                          >
                            <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
                              <Link
                                href={withSubjectVisitReturn(
                                  subjectHref({ id: row.id, label: row.label }, locale).href,
                                  selectedAddress(row),
                                  locale,
                                )}
                                lang={row.labelLanguage}
                                className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), compactWrap, 'w-full')}
                              >
                                {label}
                              </Link>
                              <Button
                                ref={(element) => {
                                  if (element) rowControls.current.set(row.key, element);
                                  else rowControls.current.delete(row.key);
                                }}
                                type="button"
                                variant="outline"
                                size="sm"
                                aria-expanded={selectedRow}
                                className={cn(compactWrap, 'w-full sm:w-auto sm:justify-self-end')}
                                onClick={() => {
                                  if (retiredVisit.current) return;
                                  originHandled.current = true;
                                  select(selectedRow ? null : row.key);
                                  setMissingOrigin(false);
                                }}
                              >
                                {selectedRow
                                  ? m.manga_reader_close_inspection({}, options(locale))
                                  : m.manga_reader_inspect({}, options(locale))}
                              </Button>
                            </div>
                            {(type || row.notes.length > 0) && (
                              <ul className="min-w-0 space-y-1 border-s-2 border-border ps-3 text-sm text-muted-foreground [overflow-wrap:anywhere]">
                                {type ? <li>{type}</li> : null}
                                {row.notes.map((note) => (
                                  <li key={`${row.key}:${note}`} className="[overflow-wrap:anywhere]">
                                    {note}
                                  </li>
                                ))}
                              </ul>
                            )}
                            {selectedRow ? (
                              <MangaOccurrenceEvidence
                                row={row}
                                locale={locale}
                                definitions={definitions}
                                propertyLabels={propertyLabels}
                                link={EvidenceLink}
                                correctionLink={EvidenceLink}
                              />
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ))}
              </section>
            )}
          </>
        )}
      </section>
    </WorkReadingProvider>
  );
}
