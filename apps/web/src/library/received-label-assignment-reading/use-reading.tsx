import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import type { LabelShelfEntry } from '../label-shelf-read';
import { displayLibraryTitle } from '../title';
import { m } from '../../paraglide/messages.js';
import {
  beginReceivedReplacement,
  chooseReceivedObservation,
  emptyReceivedReading,
  receivedObservation,
  removeReceivedObservation,
  type ReceivedObservation,
  type ReceivedReading,
} from './selection';
import {
  captureReceivedVisit,
  receivedReadingIsCurrent,
  receivedVisitMatches,
  type ReceivedReadSource,
  type ReceivedReadVisit,
} from './current';
import { ReceivedAssignmentReader } from './view';

/** Local selection consumes the parent's read origin; it owns no requests, credentials or mutation selection. */
export function useReceivedAssignmentReading(source: ReceivedReadSource) {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const latest = useRef(source);
  latest.current = source;
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      visitRef.current.active = false;
    };
  }, []);
  const visitRef = useRef(captureReceivedVisit(source));
  const [stored, setStored] = useState<{ visit: ReceivedReadVisit; reading: ReceivedReading }>(() => ({
    visit: visitRef.current,
    reading: emptyReceivedReading(),
  }));
  const focusOrigin = useRef<{ visit: ReceivedReadVisit; element: HTMLButtonElement } | null>(null);
  const shelf = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const readerId = useId();
  const membershipId = useId();

  // Retire during rendering, before old private content or late callbacks can reach the next commit.
  // A healthy display-only rerender keeps the same source observation and received rows.
  const admitted = hydrated && !!source.isCurrent?.();
  if (
    !receivedVisitMatches(visitRef.current, source) ||
    (stored.reading.selected.length > 0 &&
      (!admitted || !receivedReadingIsCurrent(visitRef.current, source, stored.reading)))
  ) {
    visitRef.current.active = false;
    visitRef.current = captureReceivedVisit(source);
    focusOrigin.current = null;
  }
  const visit = visitRef.current;
  const reading = stored.visit === visit ? stored.reading : emptyReceivedReading();
  if (stored.visit !== visit) setStored({ visit, reading });

  const current = () =>
    mounted.current &&
    hydrated &&
    visitRef.current === visit &&
    receivedReadingIsCurrent(visit, latest.current, reading);
  const change = (next: ReceivedReading) => {
    if (!current()) return;
    setStored({ visit, reading: next });
    setFocusRequest((value) => value + 1);
  };
  const restoreFocus = () => {
    if (!current()) return;
    const origin = focusOrigin.current;
    if (origin?.visit === visit && origin.element.isConnected && !origin.element.disabled) {
      origin.element.focus();
      return;
    }
    // A display change may replace the trigger. Use a stable shelf control, never a same-title row.
    const controls = shelf.current?.previousElementSibling;
    const control = controls?.querySelector<HTMLElement>('button:not([disabled]), a[href]');
    if (control?.isConnected) control.focus();
    else shelf.current?.focus();
  };
  const close = () => {
    if (!current()) return;
    restoreFocus();
    setStored({ visit, reading: emptyReceivedReading() });
    focusOrigin.current = null;
  };
  const remove = (observation: ReceivedObservation) => {
    if (!current()) return;
    if (reading.selected.length === 1) close();
    else change(removeReceivedObservation(reading, observation));
  };
  useLayoutEffect(() => {
    if (focusRequest > 0 && reading.selected.length > 0 && current()) heading.current?.focus();
  }, [focusRequest, visit]);

  const trigger = (row: LabelShelfEntry) => {
    if (!admitted || !current()) return null;
    const selected = reading.selected.some((item) => item.row === row);
    const position = source.entries.indexOf(row) + 1;
    const title = row.subject
      ? displayLibraryTitle(row.subject.label, source.locale).text
      : m.library_subject_unavailable();
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="relative z-20 h-auto min-h-11 max-w-full whitespace-normal break-words"
        data-received-assignment-trigger=""
        aria-label={m.library_received_reading_open_named({ position, title })}
        aria-controls={reading.selected.length ? readerId : undefined}
        aria-expanded={selected}
        aria-describedby={reading.selected.length ? membershipId : undefined}
        onClick={(event) => {
          event.stopPropagation();
          if (!current()) return;
          const observation = receivedObservation(latest.current.entries, latest.current.label.id, row);
          if (!observation) return;
          if (!reading.selected.length) focusOrigin.current = { visit, element: event.currentTarget };
          change(chooseReceivedObservation(reading, observation));
        }}
      >
        {selected ? m.library_received_reading_selected() : m.library_received_reading_open()}
      </Button>
    );
  };

  return {
    shelf,
    trigger,
    surface:
      admitted && current() && reading.selected.length ? (
        <ReceivedAssignmentReader
          id={readerId}
          membershipId={membershipId}
          headingRef={heading}
          label={source.label}
          locale={source.locale}
          reading={reading}
          isCurrent={current}
          close={close}
          remove={remove}
          replace={(item) => change(beginReceivedReplacement(reading, item))}
          cancelReplacement={() => change({ ...reading, replacement: null })}
        />
      ) : null,
  };
}
