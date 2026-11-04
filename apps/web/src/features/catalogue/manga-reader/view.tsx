import { useEffect, useLayoutEffect, useReducer, useRef } from 'react';
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
  link?: PageLink;
}) {
  const captured = useRef(observation);
  const retiredVisit = useRef(false);
  const [, refreshLifetime] = useReducer((version: number) => version + 1, 0);
  const heading = useRef<HTMLHeadingElement>(null);
  const focused = useRef<EventTarget | null>(null);
  if (!retiredVisit.current && mangaReaderRetired(captured.current, observation)) retiredVisit.current = true;
  const retired = retiredVisit.current;
  useEffect(() => {
    const retire = () => {
      if (retiredVisit.current) return;
      retiredVisit.current = true;
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
    const target = focused.current;
    if (retired && target instanceof Element && !target.isConnected && document.activeElement === document.body)
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
        status: mangaReaderWindowStatus([window], definitions, reader),
      }))
    : [{ key: 'unsupported', label: '', status: 'unsupported' as const }];
  const state = states.every(({ status }) => status === states[0]?.status) ? states[0]!.status : 'mixed';
  const rows = retired ? [] : mangaReaderRows(current, definitions, locale, reader);
  const measures = retired ? [] : mangaReaderMeasures(current, definitions, reader);
  const groups = new Map<string, { property: string; relation: string; kind: 'contents' | 'editions'; direction: string; rows: MangaReaderRow[] }>();
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
      <h2 ref={heading} id="manga-reader-title" tabIndex={-1} className="text-xl leading-snug font-semibold tracking-tight focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:text-2xl">
        {m.manga_reader_title({}, options(locale))}
      </h2>
      {retired ? (
        <div role="status" className="space-y-2 text-sm text-muted-foreground">
          <p>{m.manga_reader_stale({}, options(locale))}</p>
          <a
            className={`${linkClass} ${linkColor} inline-flex min-h-11 items-center`}
            href={recoveryHref}
            onClick={() => {
              captured.current = observation;
              retiredVisit.current = false;
              refreshLifetime();
            }}
          >
            {m.manga_reader_recover({}, options(locale))}
          </a>
        </div>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            <span lang={title.lang}>{title.text || m.subject_value_unlabelled({}, options(locale))}</span>
            {` · ${typeLabel}`}
          </p>
          <ul className="space-y-1 text-sm text-muted-foreground">
            {states.map(({ key, label, status }) => (
              <li key={key} role="status">{label ? `${label}: ` : ''}{statusText(status, locale)}</li>
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
                      return (
                        <li key={row.key} data-statement-id={row.statementId} className="py-2">
                          <Link
                            href={subjectHref({ id: row.id, label: row.label }, locale).href}
                            lang={row.labelLanguage}
                            className={`${linkClass} ${linkColor} inline-flex min-h-11 min-w-11 max-w-full items-center font-medium [overflow-wrap:anywhere]`}
                          >
                            {label}
                          </Link>
                          {(type || row.notes.length > 0) && (
                            <ul className="pl-3 text-sm text-muted-foreground">
                              {type ? <li>{type}</li> : null}
                              {row.notes.map((note) => <li key={`${row.key}:${note}`}>{note}</li>)}
                            </ul>
                          )}
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
