import { useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { useNavigate } from '@tanstack/react-router';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import { displayLibraryTitle } from '../title';
import { PersonalShelfOrigin } from '../personal-shelf-origin';
import type { PersonalLibraryEntry } from '../entries-read';
import type { ShelfRow } from '../shelf-rows';
import {
  captureReceivedEntryVisit,
  receivedEntryObservation,
  receivedEntryVisitIsCurrent,
  type ReceivedEntryReadSource,
  type ReceivedEntryVisit,
} from './current';
import { ReceivedEntryReader } from './view';

type Reading = { visit: ReceivedEntryVisit; row: ShelfRow };
type TriggerReference = { observation: string; element: HTMLButtonElement };

/** A local, one-row reading state that consumes the shelf's admitted page and original origin. */
export function useReceivedEntryReading(
  source: Omit<ReceivedEntryReadSource, 'origin'>,
) {
  const navigate = useNavigate();
  const origin = useContext(PersonalShelfOrigin);
  const currentSource: ReceivedEntryReadSource = { ...source, origin };
  const latest = useRef(currentSource);
  latest.current = currentSource;
  const [hydrated, setHydrated] = useState(false);
  const [originChange, setOriginChange] = useState(0);
  const [reading, setReading] = useState<Reading | null>(null);
  const readingRef = useRef<Reading | null>(reading);
  readingRef.current = reading;
  const mounted = useRef(true);
  const retireFocus = useRef(false);
  const focusOrigin = useRef<{ visit: ReceivedEntryVisit; entry: PersonalLibraryEntry; element: HTMLButtonElement } | null>(null);
  const triggerElements = useRef(new Map<string, TriggerReference>());
  const shelf = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const readerId = useId();

  useEffect(() => setHydrated(true), []);
  useEffect(() => origin?.watch(() => setOriginChange((value) => value + 1)), [origin]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (readingRef.current) readingRef.current.visit.active = false;
    };
  }, []);

  const currentRow = (visit: ReceivedEntryVisit, candidate: ReceivedEntryReadSource) =>
    candidate.rows.find(
      (row) =>
        row.entry.subjectId === visit.subjectId &&
        row.entry.revision === visit.revision &&
        row.entry.incarnationId === visit.incarnationId &&
        (row.entry.subject?.id ?? null) === visit.associatedSubjectId &&
        receivedEntryObservation(row.entry) === visit.entryObservation,
    );
  const visitCurrent = (visit: ReceivedEntryVisit, candidate = latest.current) =>
    mounted.current &&
    hydrated &&
    receivedEntryVisitIsCurrent(visit, candidate) &&
    !!currentRow(visit, candidate);
  const focusShelf = () => shelf.current?.focus();
  const retire = (focus = true) => {
    const active = readingRef.current;
    if (active) active.visit.active = false;
    readingRef.current = null;
    focusOrigin.current = null;
    setReading(null);
    if (focus) retireFocus.current = true;
  };

  // Clear private values in the same render that detects a stale source, before stale content can commit.
  if (reading && !visitCurrent(reading.visit, currentSource)) retire();

  const originTrigger = (visit: ReceivedEntryVisit, entry: PersonalLibraryEntry) => {
    const original = focusOrigin.current;
    if (
      original?.visit === visit &&
      receivedEntryObservation(original.entry) === visit.entryObservation &&
      original.element.isConnected &&
      !original.element.disabled
    )
      return original.element;
    const current = triggerElements.current.get(entry.subjectId);
    return current?.observation === visit.entryObservation && current.element.isConnected && !current.element.disabled
      ? current.element
      : undefined;
  };
  const close = () => {
    const active = readingRef.current;
    if (!active || !visitCurrent(active.visit)) {
      retire();
      return;
    }
    const target = originTrigger(active.visit, active.row.entry);
    active.visit.active = false;
    readingRef.current = null;
    focusOrigin.current = null;
    setReading(null);
    if (target) target.focus();
    else focusShelf();
  };

  useLayoutEffect(() => {
    if (retireFocus.current) {
      retireFocus.current = false;
      focusShelf();
    }
  }, [reading, originChange, source.population, source.locale]);
  useLayoutEffect(() => {
    const active = readingRef.current;
    if (focusRequest > 0 && active && visitCurrent(active.visit)) heading.current?.focus();
  }, [focusRequest, reading]);

  const registerTrigger = (entry: PersonalLibraryEntry, element: HTMLButtonElement | null) => {
    const observation = receivedEntryObservation(entry);
    if (element) triggerElements.current.set(entry.subjectId, { observation, element });
    else if (triggerElements.current.get(entry.subjectId)?.observation === observation)
      triggerElements.current.delete(entry.subjectId);
  };

  const trigger = (row: ShelfRow) => {
    const entry = row.entry;
    const observation = receivedEntryObservation(entry);
    const position =
      currentSource.population.findIndex(
        (received) => received.subjectId === entry.subjectId,
      ) + 1;
    if (!hydrated || position < 1 || !currentSource.isCurrent()) return null;
    const title = entry.subject ? displayLibraryTitle(entry.subject.label, currentSource.locale).text : null;
    const titleText = title ?? m.library_subject_unavailable({}, { locale: currentSource.locale as Locale });
    const selected =
      !!reading &&
      reading.visit.subjectId === entry.subjectId &&
      reading.visit.entryObservation === observation &&
      visitCurrent(reading.visit, currentSource);
    const options = { locale: currentSource.locale as Locale };
    return (
      <Button
        ref={(element) => registerTrigger(entry, element)}
        type="button"
        variant="outline"
        size="sm"
        className="relative z-20 h-auto min-h-11 max-w-full whitespace-normal break-words"
        aria-label={m.library_entry_reading_open_named({ position, title: titleText }, options)}
        aria-controls={reading && selected ? readerId : undefined}
        aria-expanded={!!selected}
        data-received-entry-reading-trigger=""
        onClick={(event) => {
          event.stopPropagation();
          if (!latest.current.isCurrent()) return;
          const active = readingRef.current;
          if (
            active &&
            active.visit.subjectId === entry.subjectId &&
            active.visit.entryObservation === observation &&
            visitCurrent(active.visit)
          ) {
            heading.current?.focus();
            return;
          }
          const visit = captureReceivedEntryVisit(latest.current, row);
          if (!visit) return;
          focusOrigin.current = { visit, entry, element: event.currentTarget };
          readingRef.current = { visit, row };
          setReading({ visit, row });
          setFocusRequest((value) => value + 1);
        }}
      >
        {selected
          ? m.library_entry_reading_selected({}, options)
          : m.library_entry_reading_open({}, options)}
      </Button>
    );
  };

  const active = reading && visitCurrent(reading.visit, currentSource) ? reading : null;
  const activeRow = active ? currentRow(active.visit, currentSource) : undefined;
  const openProgress = (visit: ReceivedEntryVisit, entry: PersonalLibraryEntry) => {
    if (
      !visitCurrent(visit) ||
      !latest.current.progressAdmitted() ||
      !entry.subject
    )
      return;
    visit.active = false;
    readingRef.current = null;
    setReading(null);
    focusOrigin.current = null;
    // Keep the exact existing row destination and query identity; browser history retains the shelf address.
    void navigate({ to: '/library/progress', search: { subjectId: entry.subject.id } });
  };

  return {
    shelf,
    trigger,
    surface:
      active && activeRow ? (
        <ReceivedEntryReader
          id={readerId}
          headingRef={heading}
          row={activeRow}
          locale={currentSource.locale}
          isCurrent={() => visitCurrent(active.visit)}
          progressAdmitted={currentSource.progressAdmitted()}
          close={close}
          openProgress={() => openProgress(active.visit, active.row.entry)}
        />
      ) : null,
  };
}
