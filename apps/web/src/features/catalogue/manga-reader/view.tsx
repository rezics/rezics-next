import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { subjectHref } from '../../../subject/subject-href';
import type { Subject } from '../../../subject/types';
import type { RelationDefinition } from '../../../subject/relations';
import type { Reader } from '../../../subject/reader';
import { m } from '../../../paraglide/messages.js';
import { sectionClass } from '../../pages/overview';
import { pageText, PlainLink, linkClass, linkColor, type PageLink } from '../../pages/shared';
import type { ProfileRelationWindow } from '../../pages/views';
import {
  mangaReaderMeasures,
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
}) {
  const currentObservation = { ...observation, reader: JSON.stringify(reader) };
  const captured = useRef<MangaReaderObservation | null>(currentObservation);
  const retiredVisit = useRef(false);
  const [selected, select] = useState<string | null>(null);
  const [, refreshLifetime] = useReducer((version: number) => version + 1, 0);
  const heading = useRef<HTMLHeadingElement>(null);
  const focused = useRef<EventTarget | null>(null);
  if (captured.current && mangaReaderRetired(captured.current, currentObservation)) {
    retiredVisit.current = true;
    captured.current = null;
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
  useLayoutEffect(() => {
    if (!retired) return;
    const target = focused.current;
    focused.current = null;
    if (
      target instanceof Element &&
      target.closest('[data-selected="true"]') &&
      !target.isConnected &&
      document.activeElement === document.body
    )
      heading.current?.focus();
  }, [retired]);
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
    if (retired || originHandled.current) return;
    originHandled.current = true;
    const fragment = new URL(currentHref ?? recoveryHref, 'https://rezics.invalid').hash;
    const occurrence = mangaOccurrenceFromFragment(fragment);
    if (!occurrence) return;
    const key = mangaOccurrenceKey(occurrence);
    const row = rows.find((candidate) => candidate.key === key);
    if (row) select(key);
    else setMissingOrigin(true);
    // Only an explicit occurrence return may move focus, and only while focus is still unclaimed.
    if (document.activeElement === document.body) {
      if (row) rowControls.current.get(key)?.focus();
      else heading.current?.focus();
    }
  }, [retired, currentHref, recoveryHref, rows]);
  useEffect(() => {
    if (!retired) return;
    select(null);
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
  const title = pageText(subject.labels, locale, originalLanguage(subject));
  const Link = link;
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
    <section
      id="manga-reader"
      data-slot="manga-reader"
      data-state={retired ? 'stale' : state}
      aria-labelledby="manga-reader-title"
      className={`${sectionClass} min-w-0 rounded-lg border border-border p-4 sm:p-6`}
      onFocusCapture={(event) => {
        focused.current = event.target;
      }}
    >
      <h2
        ref={heading}
        id="manga-reader-title"
        tabIndex={-1}
        className="text-xl leading-snug font-semibold tracking-tight focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:text-2xl"
      >
        {m.manga_reader_title({}, options(locale))}
      </h2>
      {retired ? (
        <div role="status" className="space-y-2 text-sm text-muted-foreground">
          <p>{m.manga_reader_stale({}, options(locale))}</p>
          <a className={`${linkClass} ${linkColor} inline-flex min-h-11 items-center`} href={recoveryHref}>
            {m.manga_reader_recover({}, options(locale))}
          </a>
          <a
            className={`${linkClass} ${linkColor} inline-flex min-h-11 items-center`}
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
                className={`${linkClass} ${linkColor} inline-flex min-h-11 items-center`}
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
          <p className="text-sm text-muted-foreground">
            <span lang={title.lang}>{title.text || m.subject_value_unlabelled({}, options(locale))}</span>
            {` · ${typeLabel}`}
          </p>
          <ul className="space-y-1 text-sm text-muted-foreground">
            {states.map(({ key, label, status, next, kind }) => (
              <li key={key} role="status">
                <p>
                  {label ? `${label}: ` : ''}
                  {statusText(status, locale)}
                </p>
                {status === 'unavailable' ? (
                  <div className="flex flex-wrap gap-x-4">
                    <a href={recoveryHref} className={`${linkClass} ${linkColor} inline-flex min-h-11 items-center`}>
                      {m.manga_reader_retry({}, options(locale))}
                    </a>
                    <a
                      href={mangaRestartAddress(recoveryHref)}
                      className={`${linkClass} ${linkColor} inline-flex min-h-11 items-center`}
                    >
                      {m.manga_reader_restart({}, options(locale))}
                    </a>
                  </div>
                ) : null}
                {status === 'populated' || status === 'empty-continued' ? (
                  view === 'overview' ? (
                    <Link
                      href={mangaWindowAddress({ id: subject.id, label: title.text }, locale, kind, observation.realm)}
                      className={`${linkClass} ${linkColor} inline-flex min-h-11 items-center`}
                    >
                      {kind === 'editions'
                        ? m.manga_reader_open_editions({}, options(locale))
                        : m.manga_reader_open_contents({}, options(locale))}
                    </Link>
                  ) : next ? (
                    <Link
                      href={mangaWindowAddress({ id: subject.id, label: title.text }, locale, kind, observation.realm, {
                        node: key,
                        cursor: next,
                      })}
                      className={`${linkClass} ${linkColor} inline-flex min-h-11 items-center`}
                    >
                      {m.manga_reader_next({}, options(locale))}
                    </Link>
                  ) : null
                ) : null}
              </li>
            ))}
          </ul>
          <p className="text-sm text-muted-foreground">{m.manga_reader_chapters_unsupported({}, options(locale))}</p>
          {measures.length > 0 && (
            <ul className="space-y-1 text-sm">
              {measures.map((measure) => (
                <li key={measure.key}>
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
          <p className="text-sm text-muted-foreground">{m.manga_reader_public_count_scope({}, options(locale))}</p>
          {groups.size > 0 && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">{m.manga_reader_native_order({}, options(locale))}</p>
              {[...groups.entries()].map(([key, group]) => (
                <section key={key} className="min-w-0 space-y-2">
                  <h3 className="text-base font-medium [overflow-wrap:anywhere]">
                    {group.kind === 'editions'
                      ? m.manga_reader_editions({}, options(locale))
                      : m.manga_reader_parts({}, options(locale))}
                    {group.relation ? ` · ${group.relation}` : ''}
                  </h3>
                  <ul className="divide-y divide-border">
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
                          className="space-y-2 py-2"
                        >
                          <Link
                            href={withSubjectVisitReturn(
                              subjectHref({ id: row.id, label: row.label }, locale).href,
                              selectedAddress(row),
                              locale,
                            )}
                            lang={row.labelLanguage}
                            className={`${linkClass} ${linkColor} inline-flex min-h-11 min-w-11 max-w-full items-center font-medium [overflow-wrap:anywhere]`}
                          >
                            {label}
                          </Link>
                          <button
                            ref={(element) => {
                              if (element) rowControls.current.set(row.key, element);
                              else rowControls.current.delete(row.key);
                            }}
                            type="button"
                            aria-expanded={selectedRow}
                            className="ms-2 inline-flex min-h-11 min-w-11 items-center rounded-sm px-2 text-sm text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                            onClick={() => {
                              if (retiredVisit.current) return;
                              select(selectedRow ? null : row.key);
                              setMissingOrigin(false);
                            }}
                          >
                            {selectedRow
                              ? m.manga_reader_close_inspection({}, options(locale))
                              : m.manga_reader_inspect({}, options(locale))}
                          </button>
                          {(type || row.notes.length > 0) && (
                            <ul className="pl-3 text-sm text-muted-foreground">
                              {type ? <li>{type}</li> : null}
                              {row.notes.map((note) => (
                                <li key={`${row.key}:${note}`}>{note}</li>
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
            </div>
          )}
        </>
      )}
    </section>
  );
}
