import type { ShelfOrigin } from '../personal-shelf-origin';
import type { PersonalLibraryEntry } from '../entries-read';
import type { ShelfRow } from '../shelf-rows';

export type ReceivedEntryReadSource = {
  /** The mounted shelf composition that admitted this page. */
  originKey: object;
  /** The exact received population, before local command reconciliation. */
  population: readonly PersonalLibraryEntry[];
  /** Rows after the existing local command reconciliation. */
  rows: readonly ShelfRow[];
  locale: string;
  isCurrent: () => boolean;
  progressAdmitted: () => boolean;
  origin: ShelfOrigin | null;
};

export type ReceivedEntryVisit = {
  active: boolean;
  originKey: object;
  origin: ShelfOrigin | null;
  originCurrent?: () => boolean;
  sourceCurrent: () => boolean;
  population: readonly string[];
  locale: string;
  entry: PersonalLibraryEntry;
  entryObservation: string;
  subjectId: string;
  revision: number;
  incarnationId: string | null | undefined;
  associatedSubjectId: string | null;
};

export function receivedEntryObservation(entry: PersonalLibraryEntry): string {
  const { changeKey: _changeKey, removeKey: _removeKey, ...observation } = entry;
  return JSON.stringify(observation);
}

function samePopulation(captured: readonly string[], current: readonly PersonalLibraryEntry[]): boolean {
  return captured.length === current.length && captured.every((key, index) => key === receivedEntryObservation(current[index]!));
}

function sameIdentity(visit: ReceivedEntryVisit, entry: PersonalLibraryEntry): boolean {
  return (
    entry.subjectId === visit.subjectId &&
    entry.revision === visit.revision &&
    entry.incarnationId === visit.incarnationId &&
    (entry.subject?.id ?? null) === visit.associatedSubjectId &&
    receivedEntryObservation(entry) === visit.entryObservation
  );
}

/** Capture the exact received row and the current shelf authority at the deliberate opening action. */
export function captureReceivedEntryVisit(
  source: ReceivedEntryReadSource,
  row: ShelfRow,
): ReceivedEntryVisit | null {
  const { entry } = row;
  const entryObservation = receivedEntryObservation(entry);
  const currentRow = source.rows.find((current) => current.entry.subjectId === entry.subjectId);
  const onPage = source.population.some((received) => received.subjectId === entry.subjectId);
  if (
    !source.isCurrent() ||
    !onPage ||
    !currentRow ||
    currentRow.entry.revision !== entry.revision ||
    currentRow.entry.incarnationId !== entry.incarnationId ||
    (currentRow.entry.subject?.id ?? null) !== (entry.subject?.id ?? null) ||
    receivedEntryObservation(currentRow.entry) !== entryObservation
  )
    return null;
  return {
    active: true,
    originKey: source.originKey,
    origin: source.origin,
    originCurrent: source.origin?.capture('library_entry.list', 'progress_session.list'),
    sourceCurrent: source.isCurrent,
    population: source.population.map(receivedEntryObservation),
    locale: source.locale,
    entry,
    entryObservation,
    subjectId: entry.subjectId,
    revision: entry.revision,
    incarnationId: entry.incarnationId,
    associatedSubjectId: entry.subject?.id ?? null,
  };
}

/** A visit survives display changes only while the same page, row and original read authority remain current. */
export function receivedEntryVisitIsCurrent(
  visit: ReceivedEntryVisit,
  source: ReceivedEntryReadSource,
): boolean {
  if (
    !visit.active ||
    visit.originKey !== source.originKey ||
    visit.origin !== source.origin ||
    visit.locale !== source.locale ||
    !samePopulation(visit.population, source.population) ||
    !source.isCurrent() ||
    !visit.sourceCurrent() ||
    !(source.origin?.current() ?? true) ||
    !(visit.originCurrent?.() ?? true)
  )
    return false;

  const row = source.rows.find((current) => current.entry.subjectId === visit.subjectId);
  return (
    !!row &&
    sameIdentity(visit, row.entry) &&
    source.population.some((entry) => entry.subjectId === visit.subjectId)
  );
}
