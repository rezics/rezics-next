import type { FeedItem, FeedPage } from '../../pages/home-feed-read';
import type { SubjectOwnRating } from '../../pages/subject-ratings';
import type { SubjectSlotEntry } from '../../../library/subject-slot';

/** The native composition owns one page, bounded before any Subject deduplication. */
export const HOME_WORK_LIBRARY_PAGE_SIZE = 100;

export type HomeWorkLibraryScope = Readonly<{
  reader: string;
  credentialEpoch: string;
  source: string;
  observation: string;
  locale: string;
  route: string;
}>;

export type HomeWorkLibraryFact<T> =
  | Readonly<{ state: 'present'; value: T }>
  | Readonly<{ state: 'absent' }>
  | Readonly<{ state: 'unavailable' }>;

export type HomeWorkLibraryRow = Readonly<{
  rowKey: string;
  subjectId: string;
  entry: HomeWorkLibraryFact<SubjectSlotEntry>;
  score: HomeWorkLibraryFact<SubjectOwnRating>;
  actions:
    | Readonly<{ state: 'current'; allowed: readonly Readonly<{ action: string; operations: readonly string[] }>[] }>
    | Readonly<{ state: 'unavailable' }>;
}>;

export type HomeWorkLibraryPage = Readonly<{
  state: 'ready' | 'unavailable';
  rows: readonly HomeWorkLibraryRow[];
}>;

export type HomeWorkLibraryLease = Readonly<{
  subscribe(listener: () => void): () => void;
  snapshot(): number;
  isCurrent(): boolean;
}>;

/** Local presentation seam, not a native DTO. Home fills it from the installed page's personal facts only. */
export type HomeWorkLibraryProjection = Readonly<{
  scope: HomeWorkLibraryScope;
  page: HomeWorkLibraryPage;
  lease: HomeWorkLibraryLease;
}>;

/** Missing rows stay unavailable. This helper never treats an omitted ID as an absent Entry or score. */
export function homeWorkLibraryRow(
  projection: HomeWorkLibraryProjection | undefined,
  rowKey: string | undefined,
  subjectId: string,
): HomeWorkLibraryRow | undefined {
  if (!projection || !rowKey || !projection.lease.isCurrent() || !isValidProjection(projection)) return;
  const page = projection.page;
  if (page.state !== 'ready') return;
  const matches = page.rows.filter((candidate) => candidate.rowKey === rowKey);
  if (matches.length !== 1) return;
  const row = matches[0]!;
  return row.subjectId === subjectId && validRow(projection, row) ? row : undefined;
}

export function sameHomeWorkLibraryScope(left: HomeWorkLibraryScope, right: HomeWorkLibraryScope): boolean {
  return (
    left.reader.length > 0 &&
    left.credentialEpoch.length > 0 &&
    left.source.length > 0 &&
    left.observation.length > 0 &&
    left.locale.length > 0 &&
    left.route.length > 0 &&
    left.reader === right.reader &&
    left.credentialEpoch === right.credentialEpoch &&
    left.source === right.source &&
    left.observation === right.observation &&
    left.locale === right.locale &&
    left.route === right.route
  );
}

export type HomeWorkLibraryAcknowledgement = Readonly<{
  scope: HomeWorkLibraryScope;
  state: 'acknowledged' | 'unknown' | 'rejected';
  commandId: string;
  rowKey: string;
  subjectId: string;
  entry?: HomeWorkLibraryFact<SubjectSlotEntry>;
  score?: HomeWorkLibraryFact<SubjectOwnRating>;
}>;

/** Only an acknowledged command from a still-admitted occurrence reconciles shared personal facts. */
export function reconcileHomeWorkLibraryAcknowledgement(
  projection: HomeWorkLibraryProjection,
  acknowledgement: HomeWorkLibraryAcknowledgement,
): HomeWorkLibraryProjection {
  if (
    acknowledgement.state !== 'acknowledged' ||
    !sameHomeWorkLibraryScope(projection.scope, acknowledgement.scope) ||
    !acknowledgement.commandId ||
    !validIdentity(acknowledgement.subjectId) ||
    !homeWorkLibraryRow(projection, acknowledgement.rowKey, acknowledgement.subjectId) ||
    (!acknowledgement.entry && !acknowledgement.score)
  )
    return projection;
  const origin = homeWorkLibraryRow(projection, acknowledgement.rowKey, acknowledgement.subjectId)!;
  if (
    !validRow(projection, {
      ...origin,
      ...(acknowledgement.entry ? { entry: acknowledgement.entry } : {}),
      ...(acknowledgement.score ? { score: acknowledgement.score } : {}),
    })
  )
    return projection;
  let changed = false;
  const rows = projection.page.rows.map((row) => {
    if (row.subjectId !== acknowledgement.subjectId || !validRow(projection, row)) return row;
    changed = true;
    return {
      ...row,
      ...(acknowledgement.entry ? { entry: acknowledgement.entry } : {}),
      ...(acknowledgement.score ? { score: acknowledgement.score } : {}),
    };
  });
  const reconciled = changed ? { ...projection, page: { ...projection.page, rows } } : projection;
  return isValidProjection(reconciled) ? reconciled : projection;
}

export function isValidProjection(projection: HomeWorkLibraryProjection): boolean {
  const page = projection.page;
  return page.rows.length <= HOME_WORK_LIBRARY_PAGE_SIZE && (page.state === 'ready' || page.rows.length === 0);
}

function validRow(projection: HomeWorkLibraryProjection, row: HomeWorkLibraryRow): boolean {
  return (
    row.rowKey.length > 0 &&
    validIdentity(row.subjectId) &&
    (row.entry.state !== 'present' || row.entry.value.subjectId === row.subjectId) &&
    (row.score.state !== 'present' ||
      (row.score.value.kind === 'ready' && row.score.value.reader === projection.scope.reader))
  );
}

/** Exact identity only: a cited review target, reply, Collection, or other subject is not promoted to a Work. */
export function admittedFeedWorkId(item: FeedItem): string | undefined {
  const summary: unknown = item.summary;
  const destination = item.destination;
  if (
    destination.kind !== 'subject' ||
    !record(summary) ||
    summary.creativeWork !== true ||
    summary.id !== destination.id ||
    !validIdentity(destination.id)
  )
    return;
  return destination.id;
}

export function admittedCatalogueWorkId(input: {
  id: string;
  summary?: { creativeWork?: boolean; id?: string } | null;
}): string | undefined {
  return input.summary?.creativeWork === true && input.summary.id === input.id && validIdentity(input.id)
    ? input.id
    : undefined;
}

function validIdentity(value: string): boolean {
  return value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The installed page's personal facts: one bounded native reading per authenticated Home response. */
export type HomeNativePersonalPage = NonNullable<FeedPage['viewerPersonalActions']>;
type NativeCurrentPage = Extract<HomeNativePersonalPage, { state: 'current' }>;
type NativeRow = NativeCurrentPage['rows'][number];

/** Only the standard counted question (scale 0–20, step 1) can supply the Home score. */
const STANDARD_QUESTION_ID = '00000000-0000-7000-8000-000000000001';

function entryFact(entry: NativeRow['entry'], subjectId: string): HomeWorkLibraryFact<SubjectSlotEntry> {
  if (entry.state === 'absent') return { state: 'absent' };
  if (entry.state !== 'present' || entry.entryState === null) return { state: 'unavailable' };
  return {
    state: 'present',
    value: { subjectId, state: entry.entryState, revision: entry.revision, incarnationId: entry.incarnationId },
  };
}

function scoreFact(
  vote: NativeRow['vote'],
  question: NativeCurrentPage['question'],
  reader: string,
): HomeWorkLibraryFact<SubjectOwnRating> {
  if (
    question === null ||
    question.id !== STANDARD_QUESTION_ID ||
    question.revision !== 1 ||
    question.scale.min !== 0 ||
    question.scale.max !== 20 ||
    question.scale.displayStep !== 1 ||
    vote.state === 'unavailable' ||
    vote.questionId !== question.id ||
    vote.questionRevision !== question.revision
  )
    return { state: 'unavailable' };
  if (vote.state === 'absent') return { state: 'absent' };
  return { state: 'present', value: { reader, kind: 'ready', units: vote.units } };
}

function actionsFact(actions: NativeRow['actions']): HomeWorkLibraryRow['actions'] {
  return actions.state === 'current' ? { state: 'current', allowed: actions.allowed } : { state: 'unavailable' };
}

/** Original occurrence keys and Subjects are kept as delivered: no join, dedupe, reindex or refill. */
export function homeWorkLibraryPage(native: HomeNativePersonalPage, reader: string): HomeWorkLibraryPage {
  if (native.state !== 'current') return { state: 'unavailable', rows: [] };
  return {
    state: 'ready',
    rows: native.rows.map((row) => ({
      rowKey: row.rowKey,
      subjectId: row.subjectId,
      entry: entryFact(row.entry, row.subjectId),
      score: scoreFact(row.vote, native.question, reader),
      actions: actionsFact(row.actions),
    })),
  };
}

/** The page's source lifetime is the feed window snapshot that delivered it; the caller supplies that lease. */
export function homeWorkLibraryFeedProjection(input: {
  native: HomeNativePersonalPage;
  scope: HomeWorkLibraryScope;
  lease: HomeWorkLibraryLease;
}): HomeWorkLibraryProjection {
  return { scope: input.scope, page: homeWorkLibraryPage(input.native, input.scope.reader), lease: input.lease };
}
