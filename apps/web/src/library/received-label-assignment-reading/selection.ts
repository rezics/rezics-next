import type { LabelShelfEntry } from '../label-shelf-read';

/** A reading observation is always one supplied assignment, never a personal Entry key. */
export type ReceivedObservation = {
  row: LabelShelfEntry;
  identity: string;
  position: number;
  subject: LabelShelfEntry['subject'];
  entryIdentity: LabelShelfEntry['entryIdentity'];
  progress: LabelShelfEntry['activeProgressSession'];
  context: LabelShelfEntry['workContext'];
  values: string;
};

export type ReceivedReading = {
  selected: readonly ReceivedObservation[];
  replacement: ReceivedObservation | null;
};

export const emptyReceivedReading = (): ReceivedReading => ({ selected: [], replacement: null });

/** No command operands or credentials belong to the reading identity. */
export function receivedIdentity(row: LabelShelfEntry): string {
  return JSON.stringify([
    row.id,
    row.labelId,
    row.subjectId,
    row.revision,
    row.subject?.id ?? null,
    row.entryIdentity?.subjectId ?? null,
    row.entryIdentity?.revision ?? null,
    row.entryIdentity?.incarnationId ?? null,
  ]);
}

/** Detect edits to a selected object without copying the other rows of the FULL page. */
function receivedValues(row: LabelShelfEntry): string {
  return JSON.stringify([
    row.state ?? null,
    row.stateLabel ?? null,
    row.subject,
    row.activeProgressSession ?? null,
    row.workContext ?? null,
  ]);
}

export function receivedObservation(
  entries: readonly LabelShelfEntry[],
  labelId: string,
  row: LabelShelfEntry,
): ReceivedObservation | null {
  const position = entries.indexOf(row);
  if (position < 0 || row.labelId !== labelId) return null;
  return {
    row,
    identity: receivedIdentity(row),
    position: position + 1,
    subject: row.subject,
    entryIdentity: row.entryIdentity,
    progress: row.activeProgressSession,
    context: row.workContext,
    values: receivedValues(row),
  };
}

export function observationIsCurrent(
  observation: ReceivedObservation,
  entries: readonly LabelShelfEntry[],
  labelId: string,
): boolean {
  return (
    observation.row.labelId === labelId &&
    entries[observation.position - 1] === observation.row &&
    receivedIdentity(observation.row) === observation.identity &&
    observation.row.subject === observation.subject &&
    observation.row.entryIdentity === observation.entryIdentity &&
    observation.row.activeProgressSession === observation.progress &&
    observation.row.workContext === observation.context &&
    receivedValues(observation.row) === observation.values
  );
}

/** Native order is retained even if the user opens the later assignment first. */
function inPageOrder(selected: readonly ReceivedObservation[]): readonly ReceivedObservation[] {
  return [...selected].sort((left, right) => left.position - right.position);
}

export function chooseReceivedObservation(reading: ReceivedReading, observation: ReceivedObservation): ReceivedReading {
  if (reading.selected.some((item) => item.row === observation.row)) return { ...reading, replacement: null };
  if (reading.replacement)
    return {
      selected: inPageOrder(reading.selected.map((item) => (item === reading.replacement ? observation : item))),
      replacement: null,
    };
  if (reading.selected.length < 2)
    return { selected: inPageOrder([...reading.selected, observation]), replacement: null };
  // A third row never becomes a retained observation. Choose a replacement slot or remove a row first.
  return reading;
}

export function beginReceivedReplacement(reading: ReceivedReading, replaced: ReceivedObservation): ReceivedReading {
  return reading.selected.includes(replaced) ? { ...reading, replacement: replaced } : reading;
}

export function removeReceivedObservation(reading: ReceivedReading, removed: ReceivedObservation): ReceivedReading {
  return { selected: reading.selected.filter((item) => item !== removed), replacement: null };
}
