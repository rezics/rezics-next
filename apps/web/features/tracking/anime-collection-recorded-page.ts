import type { CatalogueWork } from '../catalogue/work.ts';
import type { ReadingStatus } from '../catalogue/reader-actions.tsx';
import type { MainClient } from '../discover/types.ts';
import { failedRead, failureOf, isOfflineError, settle, uuidOf, type Loaded, type ReadFailure } from '../feed/types.ts';
import { dayText, momentText } from '../library/format.ts';
import type { CustomShelf, LibraryItem, StatusShelfItem } from '../library/types.ts';
import { shelfCard } from '../profile/cards.ts';
import { workHref } from '../work-page/route.ts';
import { resumeName } from './media.ts';

// Custom shelves and one status page. `readCustomShelves` and `statusShelfItems` live in the
// session library module, which a browser cannot load. These are that read and that row mapping.
const CUSTOM_SHELF_LIMIT = 20;
const MAX_CUSTOM_PAGES = 5;

function unnamedShelfWork(work: string): CatalogueWork {
  return { id: work, href: workHref(work.slice(-36)), title: null, cover: null, kind: 'book', authors: [], rating: null };
}

/** One status page in Main's order, including a placeholder where the Work could not be named. */
export function statusShelfRows(items: readonly StatusShelfItem[]): LibraryItem[] {
  return items.map(item => {
    const named = item.card ? shelfCard(item.card) : null;
    return { work: named ?? unnamedShelfWork(item.work), types: item.card?.types ?? [], status: item.status,
      version: item.version, shelvedAt: momentText(item.changedAt), startedOn: dayText(item.startedOn),
      finishedOn: dayText(item.finishedOn), rating: null, lastReadAt: null, customShelves: [],
      available: named !== null };
  });
}

/** Every custom-shelf page, in Main's order, at the library reader's page size. */
export async function readCustomShelfPages(main: MainClient, actingSubject: string) {
  let first: Awaited<ReturnType<MainClient['v1']['me']['shelves']['get']>>['data'] = null;
  const items: CustomShelf[] = [];
  let cursor: string | undefined;
  let nextCursor: string | null = null;
  for (let page = 0; page < MAX_CUSTOM_PAGES; page++) {
    const read = await settle(() => main.v1.me.shelves.get({ query: { actingSubject, limit: CUSTOM_SHELF_LIMIT, cursor } }));
    if (!read.ok) return read;
    first ??= read.data;
    items.push(...read.data.items);
    nextCursor = read.data.nextCursor;
    if (!nextCursor) break;
    cursor = nextCursor;
  }
  return { ok: true as const, data: { ...first!, items, nextCursor } };
}

// The series resume read (`position=mine`, one item) and one occurrence's progress.
// Opening a public catalogue uses a different positions query; this is the saved place.

export interface AnimeEpisodeRef { structure: string; occurrence: string }

/** The reader-status compare-and-set body the shelf write sends. */
export function readerStatusBody(actingSubject: string, expectedVersion: number, status: ReadingStatus | null) {
  return { actingSubject, expectedVersion, status };
}

/** The occurrence progress compare-and-set body `mark` sends after it has read the current version. */
export function episodeProgressBody(input: {
  actingSubject: string;
  completed: boolean;
  expectedVersion: number;
  position: string | null;
}) {
  return {
    actingSubject: input.actingSubject,
    completed: input.completed,
    expectedVersion: input.expectedVersion,
    position: input.position,
  };
}

type TreatyAnswer<T> = {
  data: T | null;
  error: { status: number; value: unknown } | null;
  headers?: unknown;
  response?: { headers?: unknown };
};

export interface AnimeRefusal {
  kind: 'refusal';
  failure: ReadFailure;
  title: string | null;
  body: unknown;
  headers: unknown;
}

export type AnimeResumeFact =
  | { kind: 'place'; work: string | null; occurrence: string; label: string | null }
  | { kind: 'absent' }
  | AnimeRefusal;

export type AnimeProgressFact =
  | {
    kind: 'progress';
    occurrence: string;
    completed: boolean;
    position: string | null;
    version: number;
    data: { completed: boolean; position: string | null; version: number };
  }
  | AnimeRefusal;

export type AnimeStatusFact =
  | { kind: 'status'; work: string; status: string | null; version: number; replayed: boolean }
  | AnimeRefusal;

/** The problem sentence an answer carried. A status code alone is not a title. */
export function problemTitle(value: unknown): string | null {
  if (!value || typeof value !== 'object' || !('title' in value)) return null;
  const title = value.title;
  return typeof title === 'string' && title.length > 0 ? title : null;
}

function refusal<T>(answer: TreatyAnswer<T>): AnimeRefusal {
  const status = answer.error?.status ?? 503;
  const body = answer.error?.value;
  return {
    kind: 'refusal',
    failure: answer.error ? failureOf(status, body) : 'unavailable',
    title: answer.error ? problemTitle(body) : null,
    body,
    headers: answer.headers ?? answer.response?.headers,
  };
}

function transportRefusal(error: unknown): AnimeRefusal {
  return { kind: 'refusal', failure: isOfflineError(error) ? 'offline' : 'unavailable', title: null, body: undefined, headers: undefined };
}

interface ResumePage {
  work?: string;
  scope?: string;
  resolved?: string;
  complete?: boolean;
  items?: { occurrence?: string; displayLabel?: string; labels?: { value?: string | null }[] }[];
}

/** A fenced completed resume names one occurrence. Any other positions window names none. */
export function mapAnimeResume(answer: TreatyAnswer<ResumePage>): AnimeResumeFact {
  if (answer.error || !answer.data) return refusal(answer);
  const page = answer.data;
  if (page.scope !== 'resume' || page.complete !== true) return { kind: 'absent' };
  const item = page.items?.[0];
  const occurrence = item?.occurrence ?? (page.resolved?.startsWith('https://') ? page.resolved : null);
  // A positions window may resolve a place without ever reading private saved progress.
  if (!occurrence) return { kind: 'absent' };
  return { kind: 'place', work: typeof page.work === 'string' ? page.work : null, occurrence, label: resumeName(item) };
}

interface ProgressPage {
  occurrence?: string;
  completed?: boolean;
  position?: string | null;
  version?: number;
}

export function mapAnimeProgress(answer: TreatyAnswer<ProgressPage>, episode: AnimeEpisodeRef): AnimeProgressFact {
  if (answer.error || !answer.data) return refusal(answer);
  const page = answer.data;
  if (typeof page.completed !== 'boolean' || typeof page.version !== 'number'
    || (page.position !== null && page.position !== undefined && typeof page.position !== 'string')) {
    return { kind: 'refusal', failure: 'unavailable', title: null, body: page, headers: answer.headers ?? answer.response?.headers };
  }
  const position = page.position ?? null;
  return {
    kind: 'progress',
    occurrence: page.occurrence ?? episode.occurrence,
    completed: page.completed,
    position,
    version: page.version,
    data: { completed: page.completed, position, version: page.version },
  };
}

interface StatusPage { work?: string; status?: string | null; version?: number; replayed?: boolean }

export function mapAnimeReaderStatus(answer: TreatyAnswer<StatusPage>): AnimeStatusFact {
  if (answer.error || !answer.data) return refusal(answer);
  const page = answer.data;
  if ((page.status !== null && typeof page.status !== 'string') || typeof page.version !== 'number'
    || typeof page.replayed !== 'boolean' || !page.work) {
    return { kind: 'refusal', failure: 'unavailable', title: null, body: page, headers: answer.headers ?? answer.response?.headers };
  }
  return { kind: 'status', work: page.work, status: page.status ?? null, version: page.version, replayed: page.replayed };
}

export async function readAnimeEpisodeResume(main: MainClient, actingSubject: string, work: string): Promise<AnimeResumeFact> {
  try {
    return mapAnimeResume(await main.v1['reading-positions']({ work: uuidOf(work) }).get({
      query: { actingSubject, position: 'mine', limit: 1 },
    }));
  } catch (error) {
    return transportRefusal(error);
  }
}

export async function readAnimeEpisodeProgress(main: MainClient, actingSubject: string, episode: AnimeEpisodeRef):
  Promise<AnimeProgressFact> {
  try {
    return mapAnimeProgress(await main.v1.compositions({ id: uuidOf(episode.structure) })
      .occurrences({ occurrence: uuidOf(episode.occurrence) }).progress.get({
        query: { actingSubject },
      }), episode);
  } catch (error) {
    return transportRefusal(error);
  }
}

export function putAnimeReaderStatus(
  main: MainClient,
  work: string,
  body: ReturnType<typeof readerStatusBody>,
  idempotencyKey: string,
) {
  return main.v1.works({ id: uuidOf(work) })['reader-status'].put(body, {
    headers: { 'idempotency-key': idempotencyKey },
  });
}

export function putAnimeEpisodeProgress(
  main: MainClient,
  episode: AnimeEpisodeRef,
  body: ReturnType<typeof episodeProgressBody>,
  idempotencyKey: string,
) {
  return main.v1.compositions({ id: uuidOf(episode.structure) })
    .occurrences({ occurrence: uuidOf(episode.occurrence) }).progress.put(body, {
      headers: { 'idempotency-key': idempotencyKey },
    });
}

/** `Loaded` for the episode adapter. The problem title stays on the fact the page renders. */
export function loadedResume(fact: AnimeResumeFact): Loaded<{ occurrence: string; label: string | null } | null> {
  if (fact.kind === 'place') return { ok: true, data: { occurrence: fact.occurrence, label: fact.label } };
  if (fact.kind === 'absent') return { ok: true, data: null };
  return failedRead(fact.failure, fact.body, fact.headers);
}

export function loadedProgress(fact: AnimeProgressFact): Loaded<{ completed: boolean; position: string | null; version: number }> {
  if (fact.kind === 'progress') return { ok: true, data: fact.data };
  return failedRead(fact.failure, fact.body, fact.headers);
}


