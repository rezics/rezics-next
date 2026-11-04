import type { SubjectRead } from '@rezics/client';
import { relatedTarget, type ReleaseStream } from '../model';
import type { ReleaseFidelityRead, ReleaseRow } from '../read';

export type ReleasePageRead = Omit<Extract<ReleaseFidelityRead, { ok: true }>, 'detail'>;

/** The one admitted page address held by this open reader visit. */
export type ReleasePageAddress = {
  stream?: string;
  cursor?: string;
  session?: string;
  digest: string;
  revision: number;
};

/** A row occurrence is identified by its holder and statement as well as its directed stream and target. */
export type ReleaseOccurrence = {
  key: string;
  stream: string;
  relation: string;
  direction: ReleaseStream['direction'];
  holder: string;
  statementId: string;
  target: string;
};

export type AdmittedReleasePage = {
  read: ReleasePageRead;
  address: ReleasePageAddress;
};

export type ReleasePageIntent = {
  kind: 'page';
  stream?: string;
  cursor?: string;
  session?: string;
};

export type ReleaseSelectionIntent = {
  kind: 'selection';
  page: ReleasePageAddress;
  selection: ReleaseOccurrence;
};

export type ReleaseReadIntent = ReleasePageIntent | ReleaseSelectionIntent;

export type ReleaseReadingState =
  | { kind: 'loading-page'; intent: ReleasePageIntent; revision: number; admitted?: AdmittedReleasePage }
  | { kind: 'loading-recovery'; intent: ReleaseReadIntent; revision: number }
  | { kind: 'loading-selection'; admitted: AdmittedReleasePage; selection: ReleaseOccurrence; revision: number }
  | { kind: 'page'; admitted: AdmittedReleasePage }
  | { kind: 'selected'; admitted: AdmittedReleasePage; selection: ReleaseOccurrence; detail: SubjectRead }
  | { kind: 'selection-unavailable'; admitted: AdmittedReleasePage; selection: ReleaseOccurrence }
  | { kind: 'selection-concealed'; admitted: AdmittedReleasePage; selection: ReleaseOccurrence }
  | { kind: 'selection-unreadable'; admitted: AdmittedReleasePage; selection: ReleaseOccurrence }
  | { kind: 'selection-stale'; admitted: AdmittedReleasePage; selection: ReleaseOccurrence }
  | { kind: 'failed'; intent: ReleaseReadIntent; failure: Extract<ReleaseFidelityRead, { ok: false }>; revision: number };

/** Only navigation intent is kept while the existing correction is open. */
export type ReleaseReturnReceipt = {
  digest: string;
  stream?: string;
  cursor?: string;
  revision: number;
  occurrence: string;
};

export function rowTarget(row: ReleaseRow, stream: ReleaseStream): string | undefined {
  return stream.direction === 'inverse' ? row.holder : row.statement ? relatedTarget(row.statement) : undefined;
}

export function occurrenceFor(
  row: ReleaseRow,
  stream: ReleaseStream,
): ReleaseOccurrence | undefined {
  const target = rowTarget(row, stream);
  if (!target) return;
  const identity = [stream.key, stream.property, stream.direction, row.holder, row.statementId, target];
  return {
    key: JSON.stringify(identity),
    stream: stream.key,
    relation: stream.property,
    direction: stream.direction,
    holder: row.holder,
    statementId: row.statementId,
    target,
  };
}

export function admittedPage(
  read: Extract<ReleaseFidelityRead, { ok: true }>,
  intent: ReleaseReadIntent,
  revision: number,
): AdmittedReleasePage {
  const { detail: _detail, ...page } = read;
  const prior = intent.kind === 'page' ? intent : intent.page;
  return {
    read: page,
    address: {
      ...((read.stream?.key ?? prior.stream) ? { stream: read.stream?.key ?? prior.stream } : {}),
      ...(prior.cursor ? { cursor: prior.cursor } : {}),
      ...(read.session ?? prior.session ? { session: read.session ?? prior.session } : {}),
      digest: read.digest,
      revision,
    },
  };
}

export function pageIntent(page: ReleasePageAddress): ReleasePageIntent {
  return {
    kind: 'page',
    ...(page.stream ? { stream: page.stream } : {}),
    ...(page.cursor ? { cursor: page.cursor } : {}),
    ...(page.session ? { session: page.session } : {}),
  };
}

export function selectionIntent(page: ReleasePageAddress, selection: ReleaseOccurrence): ReleaseSelectionIntent {
  return { kind: 'selection', page, selection };
}

export function admittedRow(
  page: AdmittedReleasePage,
  occurrence: ReleaseOccurrence,
): ReleaseRow | undefined {
  const stream = page.read.stream;
  if (
    !stream ||
    stream.key !== occurrence.stream ||
    stream.property !== occurrence.relation ||
    stream.direction !== occurrence.direction
  )
    return;
  return page.read.rows.find((row) => {
    if (row.holder !== occurrence.holder || row.statementId !== occurrence.statementId) return false;
    return rowTarget(row, stream) === occurrence.target;
  });
}

export function returnReceipt(page: AdmittedReleasePage, occurrence: ReleaseOccurrence): ReleaseReturnReceipt {
  return {
    digest: page.address.digest,
    ...(page.address.stream ? { stream: page.address.stream } : {}),
    ...(page.address.cursor ? { cursor: page.address.cursor } : {}),
    revision: page.address.revision,
    occurrence: occurrence.key,
  };
}

export function returnReceiptCurrent(state: ReleaseReadingState, receipt: ReleaseReturnReceipt): boolean {
  if (
    state.kind === 'failed' ||
    state.kind === 'loading-page' ||
    state.kind === 'loading-recovery' ||
    state.kind === 'loading-selection'
  )
    return false;
  const page = state.admitted;
  return (
    page.address.digest === receipt.digest &&
    page.address.stream === receipt.stream &&
    page.address.cursor === receipt.cursor &&
    page.address.revision === receipt.revision &&
    ('selection' in state ? state.selection.key === receipt.occurrence : false) &&
    !!('selection' in state && admittedRow(page, state.selection))
  );
}
