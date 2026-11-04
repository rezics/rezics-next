import type { LabelShelfEntry } from '../label-shelf-read';
import { observationIsCurrent, type ReceivedReading } from './selection';

export type ReceivedReadSource = {
  /** The actual admitted FULL response, including its cursor/Label visit, rather than an ID match. */
  observation: object;
  entries: readonly LabelShelfEntry[];
  label: { id: string; name: string };
  locale: string;
  isCurrent: (() => boolean) | undefined;
};

export type ReceivedReadVisit = {
  active: boolean;
  observation: object;
  entries: readonly LabelShelfEntry[];
  labelId: string;
  labelName: string;
  locale: string;
};

export function captureReceivedVisit(source: ReceivedReadSource): ReceivedReadVisit {
  return {
    active: true,
    observation: source.observation,
    entries: source.entries,
    labelId: source.label.id,
    labelName: source.label.name,
    locale: source.locale,
  };
}

export function receivedVisitMatches(visit: ReceivedReadVisit, source: ReceivedReadSource): boolean {
  return (
    visit.active &&
    visit.observation === source.observation &&
    visit.entries === source.entries &&
    visit.labelId === source.label.id &&
    visit.labelName === source.label.name &&
    visit.locale === source.locale
  );
}

export function receivedReadingIsCurrent(
  visit: ReceivedReadVisit,
  source: ReceivedReadSource,
  reading: ReceivedReading,
): boolean {
  return (
    !!source.isCurrent?.() &&
    receivedVisitMatches(visit, source) &&
    reading.selected.length <= 2 &&
    reading.selected.every((item) => observationIsCurrent(item, source.entries, source.label.id)) &&
    (!reading.replacement || reading.selected.includes(reading.replacement))
  );
}
