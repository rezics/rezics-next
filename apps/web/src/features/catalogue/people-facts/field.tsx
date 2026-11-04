import { useRef, useState } from 'react';
import { m } from '../../../paraglide/messages.js';
import { ProfileFact, type ProfileReading } from '../person-reader/reader';
import type { profileFields } from '../person-reader/model';
import { factFieldAnchor, factVisitBounds } from './model';
import { factControl, useFactVisit } from './visit';

/** Read only visible assertion text: closed evidence and unrevealed spoilers never enter a filter. */
function displayedText(node: Node): string {
  if (node.nodeType === 3) return node.textContent ?? '';
  if (!(node instanceof Element) || node.matches('[hidden], [inert], [aria-hidden="true"]')) return '';
  if (node.tagName === 'DETAILS' && !node.hasAttribute('open')) {
    const summary = node.querySelector('summary');
    return summary ? displayedText(summary) : '';
  }
  return Array.from(node.childNodes, displayedText).join(' ');
}

export function PeopleFactField({
  field,
  reading,
}: {
  field: ReturnType<typeof profileFields>[number];
  reading: ProfileReading;
}) {
  const visit = useFactVisit();
  const [offset, setOffset] = useState(0);
  const [filter, setFilter] = useState('');
  const [matches, setMatches] = useState<ReadonlySet<string>>();
  const list = useRef<HTMLUListElement>(null);
  const o = { locale: reading.locale as never };
  const expanded = visit?.expanded === field.id;
  const admitted = visit?.projection?.fields[field.id];
  const facts = expanded && admitted ? admitted.slice(offset, offset + factVisitBounds.rows) : field.facts;
  function reset() {
    setFilter('');
    setMatches(undefined);
  }
  function move(next: number) {
    reset();
    setOffset(next);
  }
  const absence = reading.public.subject.resolution[field.id];
  return (
    <section className="min-w-0 space-y-3" data-slot="people-fact-field">
      <h4
        id={factFieldAnchor(field.id)}
        tabIndex={-1}
        lang={field.label.lang ?? undefined}
        className="font-medium focus-visible:outline-2 focus-visible:outline-ring"
      >
        {field.label.text || m.subject_value_unlabelled({}, o)}
      </h4>
      {!field.presentable ? (
        <p role="status">{m.people_facts_unsupported({}, o)}</p>
      ) : (
        <>
          {!facts.length && (
            <p role="status">
              {absence === 'suppressed'
                ? m.people_facts_suppressed({}, o)
                : absence === 'unresolved'
                  ? m.people_facts_unresolved({}, o)
                  : m.people_biography_absent({}, o)}
            </p>
          )}
          {expanded && admitted && (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">{m.people_facts_scope({}, o)}</p>
              <label className="block space-y-1">
                <span>{m.people_facts_filter({}, o)}</span>
                <input
                  type="search"
                  maxLength={factVisitBounds.filter}
                  value={filter}
                  className="block min-h-11 w-full rounded border p-2"
                  onChange={(event) => {
                    const query = event.currentTarget.value.slice(0, factVisitBounds.filter);
                    setFilter(query);
                    const text = query.trim().toLocaleLowerCase(reading.locale);
                    setMatches(
                      text
                        ? new Set(
                            facts
                              .filter((fact) => {
                                const row = Array.from(list.current?.children ?? []).find(
                                  (row) => row.getAttribute('data-statement') === fact.id,
                                );
                                const content = row?.querySelector('[data-fact-text]');
                                return (
                                  content && displayedText(content).toLocaleLowerCase(reading.locale).includes(text)
                                );
                              })
                              .map((fact) => fact.id),
                          )
                        : undefined,
                    );
                  }}
                />
              </label>
              <button type="button" className={factControl} onClick={reset}>
                {m.people_facts_reset({}, o)}
              </button>
              {matches?.size === 0 && <p role="status">{m.people_facts_empty({}, o)}</p>}
            </div>
          )}
          <ul ref={list} className="space-y-4" data-slot="people-fact-window">
            {facts.map((statement) => (
              <li
                key={statement.id}
                data-statement={statement.id}
                hidden={!!matches && !matches.has(statement.id)}
                className="min-w-0"
              >
                <ProfileFact statement={statement} reading={reading} />
              </li>
            ))}
          </ul>
          {expanded && admitted ? (
            <nav aria-label={m.people_facts_window({}, o)} className="flex flex-wrap gap-3">
              <button
                type="button"
                className={factControl}
                disabled={offset === 0}
                onClick={() => move(Math.max(0, offset - factVisitBounds.rows))}
              >
                {m.people_facts_previous({}, o)}
              </button>
              <button
                type="button"
                className={factControl}
                disabled={offset + factVisitBounds.rows >= admitted.length}
                onClick={() => move(offset + factVisitBounds.rows)}
              >
                {m.people_facts_next({}, o)}
              </button>
              <button
                type="button"
                className={factControl}
                onClick={() => {
                  reset();
                  setOffset(0);
                  visit?.expand(undefined);
                }}
              >
                {m.people_facts_collapse({}, o)}
              </button>
            </nav>
          ) : visit?.projection ? (
            <button
              type="button"
              className={factControl}
              onClick={() => {
                reset();
                setOffset(0);
                visit.expand(field.id);
              }}
            >
              {m.people_facts_browse({}, o)}
            </button>
          ) : (
            <p role="status">{m.people_facts_unavailable({}, o)}</p>
          )}
          {(!expanded || !admitted) && field.more && (
            <p className="text-sm text-muted-foreground">{m.people_facts_overflow({}, o)}</p>
          )}
        </>
      )}
    </section>
  );
}
